/**
 * 图片编辑器（C11 · 最小图层模型 v2 落地后）。
 *
 * ## 布局（2026-10-23 按实际 JSX 核对过；改了布局请同步这张图）
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 文档栏  [侧栏开关] [新建] [导入图层] │ 文件名 · 画布 W×H             │
 * │         [撤销][重做] [旋转×2][翻转×2] [导出] [缩放- 100% + 全览] [右栏]│
 * ├──────┬───────────────────────────────────────────────────────────────┤
 * │ 工具 │ 工具选项条（随工具变：吸附 / 裁剪比例 / W·H·角度 / 缩放预设）   │
 * │ 栏   ├───────────────────────────────────────────────────────────────┤
 * │ 竖排 │ 画布（视口：平移缩放；内层画布容器 overflow:hidden 负责裁切）    │
 * │      ├───────────────────────────────────────────────────────────────┤
 * │      │ 状态栏（工具提示 · 画布尺寸 · 缩放比）                          │
 * └──────┴───────────────────────────────────────────────────────────────┘
 * ```
 *
 * **文档栏是贯穿顶部的整行**，工具选项条在右列——这不是排版偏好，是 §10.1 的分界：
 * 文档栏放**画布级/文档级**动作（旋转画布、导出、历史），选项条放**工具级**参数
 * （吸附开关、图层角度）。两者分处两地，用户才不会把"旋转画布"和"旋转图层"搞混。
 * 旧版注释把文档栏画在工具栏右边、还写了"关闭"按钮，都是 `e55afc2` 之前的形态。
 *
 * 另：旧文档（v1 数据）会在文档栏之上多一条黄色提示条；新建文档对话框是覆盖层。
 *
 * ## v2：画布与图层分离（最小图层模型）
 *
 * 这一版把 v1 的"图即画布"改成了**画布 + 图层**：
 *
 * ```
 * <视口 overflow:hidden>
 *   └ <画布容器 width=canvas.w height=canvas.h overflow:hidden 背景=canvas.background>
 *       └ <图层 img src=原文件 transform=matrix(a,b,c,d,e,f)>
 * ```
 *
 * 由此得到三件事：
 * 1. **图层可以脱离画布**——缩小、旋转任意角、超出边界（自由变形的前提）；
 * 2. **画布可以脱离图层**——新建空白文档（S6）；
 * 3. **变换不再重跑 Rust**——CSS 出预览、Rust 出导出，两端共用同一组矩阵六参
 *    （`layerTransform.ts` 的 `composeMatrix`）。这与调色是同一个模式。
 *
 * 图层的显示源是**原文件**（`convertFileSrc`），不是 v1 那张 2048 的 JPEG 代理——
 * 放大到 100% 终于能看到真像素（设计稿 §4.4：编辑器曾是本项目唯一看不到原图的看图路径）。
 * Rust 代理降级为**缩略图与超大图打底**用。
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
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  FileOutput,
  FilePlus,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  ImagePlus,
  Loader2,
  RotateCcw,
  RotateCw,
  Redo2,
  Save,
  SaveAll,
  Scan,
  Undo2,
  ZoomIn,
  ZoomOut,
  Sidebar,
  PanelRight,
} from 'lucide-react';
import { computeFitTransform, Transform, zoomAtPoint } from '../comparer/viewport';
import { EditOverlay } from '../comparer/EditOverlay';
import type { ComparisonItem } from '../comparer/types';
import { isTextEditingTarget } from '../../utils/keyboardTarget';
import type { EditorCanvas, EditorDocument, EditorLayer, EditorToolId, LayerBox } from '../../types';
import { EditorToolbar } from './EditorToolbar';
import { EditorOptionsBar } from './EditorOptionsBar';
import { EditorStatusBar } from './EditorStatusBar';
import { CropOverlay, CropArea } from './CropOverlay';
import { NewDocumentDialog } from './NewDocumentDialog';
import { buildAdjustMatrix, isZeroAdjustments, toFeColorMatrixValues } from './colorMatrix';
import {
  buildLayerPreviewKey,
  createCanvas,
  createLayerId,
  createOrientedImageLayer,
  documentGeometrySignature,
  documentStateSignature,
  EDITOR_DOC_VERSION,
  isLegacyEditorDocument,
  layerBlend,
  layerOpacity,
  orientationToBox,
  removeLayer,
  resolveActiveLayer,
} from './layerModel';
import { loadLayerProxy } from './layerProxy';
import {
  composeMatrix,
  flipDocumentCanvas,
  pointInBox,
  rotateDocumentCanvas,
  toCssMatrix,
} from './layerTransform';
import { AutoSelectMode, EDITOR_SHORTCUT_KEYS } from './editorTools';
import { formatBytes, isProjectPath } from './projectFile';
import { openProjectDialog, saveProject } from './projectIo';
import {
  clearEditorView,
  peekPanRequest,
  setEditorView,
  subscribeEditorView,
} from './editorViewStore';
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
  /** 文档句柄。canvas/layers 未初始化时编辑器会自己补（从图层图读自然尺寸） */
  document?: EditorDocument;
  /** `null` = 没有选中工具（同一个快捷键/按钮再按一次就取消，用户 2026-10-24 的意见） */
  tool: EditorToolId | null;
  onToolChange: (tool: EditorToolId | null) => void;
  /**
   * 是否为当前激活的 Tab。
   *
   * 多个编辑器标签会同时挂载（非激活的用 `hidden` 藏起来，但**没有卸载**），
   * 而键盘监听挂在 window 上 —— 不做这个判断，按一次 `V` 会让所有编辑器一起切工具。
   */
  isActive: boolean;
  /** 文档变化后回报；调用方负责写回 TabState.editorDocument */
  onDocumentChange: (next: EditorDocument) => void;
  /**
   * 导出成功后回调：调用方应重扫导出的目标文件夹，让新文件进库并出现在网格里。
   *
   * 不在这里直接调 `scan_file`：单文件扫描只返回节点、**不写数据库**，
   * 网格的数据源是 `state.files`（来自扫描 + 库），单插一个节点会和库对不上。
   */
  onFileCreated?: (targetPath: string) => void | Promise<void>;
  /** 新建空白文档（由上层开一个新标签页——一个 Tab 一个文档） */
  onNewDocument?: (canvas: EditorCanvas) => void;
  /**
   * 打开 `.aurora` 工程（同样由上层开一个新标签页）。
   *
   * 传进来的是**已就绪**的文档：画布与图层都由 Rust 读好了，编辑器不会再走
   * "问代理要尺寸、建画布"的初始化路径。
   */
  onOpenProject?: (doc: EditorDocument) => void;
  /** 切换左侧面板（与应用 TopBar 同一套开关，含安卓端互斥逻辑） */
  onToggleSidebar: () => void;
  isSidebarVisible: boolean;
  /** 切换右侧面板 */
  onToggleMetadata: () => void;
  isMetadataVisible: boolean;
}

/** 撤销栈里的一步：只存参数，不存像素（一个 3440×1440 文档撤销十次就是几百 MB）。 */
interface DocSnapshot {
  canvas?: EditorCanvas;
  layers?: EditorLayer[];
}

/** `editor_load_layer_proxy` 的返回与请求去重都在 `layerProxy.ts`（面板也要用同一张表）。 */

const FIT_PADDING = 60;
const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
/** 滚轮缩放的每格倍率（PS 的一格约 1.1 倍，手感比 1.25 细腻） */
const WHEEL_ZOOM_STEP = 1.1;
/** 缩放工具单击的倍率 */
const CLICK_ZOOM_STEP = 1.25;

export const ImageEditor: React.FC<ImageEditorProps> = ({
  tabId,
  document: doc,
  tool,
  onToolChange,
  isActive,
  onDocumentChange,
  onFileCreated,
  onNewDocument,
  onOpenProject,
  onToggleSidebar,
  isSidebarVisible,
  onToggleMetadata,
  isMetadataVisible,
}) => {
  const canvas = doc?.canvas;
  const layers = useMemo(() => doc?.layers ?? [], [doc]);
  const layerCount = layers.length;
  const activeLayer = useMemo(() => (doc ? resolveActiveLayer(doc) : undefined), [doc]);

  // ---- 调色预览 ----
  // 预览走浏览器原生 SVG feColorMatrix（GPU，拖动零延迟），导出走 Rust 逐像素。
  // 两端用同一套矩阵公式（见 colorMatrix.ts 顶部注释），矩阵值由单测锁死。
  const adjustFilterId = `aurora-editor-adjust-${tabId}`;
  const adjust = activeLayer?.adjust;
  const hasAdjust = !isZeroAdjustments(adjust);
  const adjustValues = useMemo(() => toFeColorMatrixValues(buildAdjustMatrix(adjust)), [adjust]);

  /**
   * 每个图层一份滤镜。
   *
   * 不能所有图层共用 `adjustFilterId`：那张滤镜的矩阵来自**活动图层**，两个图层调色
   * 不同时非活动层会被套上错的颜色。所以画布上每层引用自己的 id；`adjustFilterId`
   * 保留给右侧面板的缩略图（它只显示活动图层）。
   */
  const layerFilterId = (layerId: string) => `aurora-editor-layer-${tabId}-${layerId}`;
  const layerFilters = useMemo(
    () =>
      (doc?.layers ?? []).map(l => ({
        id: layerFilterId(l.id),
        values: toFeColorMatrixValues(buildAdjustMatrix(l.adjust)),
        on: !isZeroAdjustments(l.adjust),
      })),
    // layerFilterId 只依赖 tabId，变化时 layers 也会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc?.layers, tabId],
  );

  // ---- 撤销 / 重做 ----
  const [history, setHistory] = useState<{ stack: DocSnapshot[]; index: number; lastAt: number }>({
    stack: [],
    index: -1,
    lastAt: 0,
  });
  const historyInitRef = useRef<string | null>(null);
  const applyingHistoryRef = useRef(false);
  const lastSignatureRef = useRef<string | null>(null);

  // 文档身份（是否已建画布）变化时以当前状态作为历史起点。
  //
  // **刻意不含 `doc.path`**：保存工程会把路径从 `photo.jpg` 换成 `photo.aurora`，
  // 若路径算进身份，"存一次"就等价于"换了一份文档"，撤销栈当场清空——用户刚存完
  // 想再撤销一步就发现没了。一个 Tab 恒等于一个文档（`openInEditor` / `openBlankDocument`
  // / `openProjectInEditor` 都是开新 Tab），所以"画布是否就绪"足以分段。
  const docIdentity = doc ? (canvas ? 'ready' : 'new') : null;
  /**
   * 上一次的活动图层 id——用来识别「用户在图层面板里换了一层」。
   *
   * `layerSelected` 原本只由画布上的点击置 true。面板里点一行若什么都不发生，
   * 用户会以为没生效（行高亮了、画布上却没有框）。所以选区变化时把框亮出来，
   * 但**只认「从 id 变到另一个 id」**：首次建栈（undefined → id）不算，
   * 那时用户什么都没点，PS 打开文件也不会先画一个框。
   */
  const prevActiveLayerIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!docIdentity || !doc) return;
    if (historyInitRef.current === docIdentity) return;
    historyInitRef.current = docIdentity;
    lastSignatureRef.current = documentStateSignature(doc);
    setHistory({ stack: [{ canvas: doc.canvas, layers: doc.layers }], index: 0, lastAt: 0 });
    setLayerSelected(false); // 新文档/刚打开：什么都没点，不该有选中框
    prevActiveLayerIdRef.current = doc.activeLayerId;
  }, [docIdentity, doc]);

  // 面板里换了一层 ⇒ 直接把变换框亮出来（见 prevActiveLayerIdRef 的说明）
  useEffect(() => {
    const id = doc?.activeLayerId;
    const prev = prevActiveLayerIdRef.current;
    prevActiveLayerIdRef.current = id;
    if (id && prev && id !== prev) setLayerSelected(true);
  }, [doc?.activeLayerId]);

  // 所有变更（裁剪 / 旋转 / 翻转 / 调色）最终都落到文档上，所以统一在这里入栈——
  // 一处收口，不用在每个 handler 里各记一次。
  useEffect(() => {
    if (!doc) return;
    const sig = documentStateSignature(doc);
    const prevSig = lastSignatureRef.current;
    lastSignatureRef.current = sig;
    if (prevSig === null) return; // 第一次由上面的 docIdentity 分支建栈
    if (sig === prevSig) return;
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false; // 这次变化是撤销/重做自己造成的
      return;
    }

    // 只有调色在动 = 用户正拖着滑杆 → 合并进栈顶，否则 Ctrl+Z 要按几百下
    const snap: DocSnapshot = { canvas: doc.canvas, layers: doc.layers };
    setHistory(h => {
      const at = h.stack[h.index];
      const geometryUnchanged =
        !!at && documentGeometrySignature({ ...doc, ...at } as EditorDocument) === documentGeometrySignature(doc);
      const merge = geometryUnchanged && Date.now() - h.lastAt < 700;
      const head = h.stack.slice(0, merge ? h.index : h.index + 1);
      head.push(snap);
      return { stack: head, index: head.length - 1, lastAt: Date.now() };
    });
  }, [doc]);

  const canUndo = history.index > 0;
  const canRedo = history.index >= 0 && history.index < history.stack.length - 1;

  const applyHistoryAt = useCallback(
    (index: number) => {
      const snap = history.stack[index];
      if (!snap || !doc) return;
      applyingHistoryRef.current = true;
      setHistory(prev => ({ ...prev, index, lastAt: 0 }));
      onDocumentChange({ ...doc, canvas: snap.canvas, layers: snap.layers, dirty: true });
    },
    [history.stack, doc, onDocumentChange],
  );

  const undo = useCallback(() => {
    if (canUndo) applyHistoryAt(history.index - 1);
  }, [canUndo, history.index, applyHistoryAt]);
  const redo = useCallback(() => {
    if (canRedo) applyHistoryAt(history.index + 1);
  }, [canRedo, history.index, applyHistoryAt]);

  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  /** 裁剪框（**画布坐标系**）。null = 不在裁剪态 */
  const [cropRect, setCropRect] = useState<CropArea | null>(null);
  /**
   * 移动工具的「自动选择」：
   * - `layer`（默认）：点画布时按顶层优先选中被点中的图层，再拖动它 —— 这就是 PS 那档；
   * - `none`：点画布**不换**选中层，只能拖当前选中的那层（换层走图层面板），
   *   也是 PS 的出厂默认值。图层多了之后自动选择容易"点一下就换了层"。
   */
  const [autoSelect, setAutoSelect] = useState<AutoSelectMode>('layer');
  const hasFittedRef = useRef(false);
  const draggingRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const spaceHeldRef = useRef(false);
  const altHeldRef = useRef(false);
  const toolRef = useRef<EditorToolId | null>(tool);
  toolRef.current = tool;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const [error, setError] = useState<string | null>(null);
  const [showNewDoc, setShowNewDoc] = useState(false);
  // 键盘 effect 只挂一次，弹窗开关要走 ref（与 toolRef 同一个理由）
  const showNewDocRef = useRef(false);
  showNewDocRef.current = showNewDoc;

  // ---- 文档初始化 ----
  //
  // 从画廊进来时只有 `{path, name}`（App 建 Tab 时不知道图多大）。这里问 Rust 要
  // **存储尺寸 + EXIF 方向**，而不是读浏览器 `<img>.naturalWidth`：浏览器对 `<img>`
  // 默认按 EXIF 自动转正，给出的宽高是"转正后"的，而导出走的是存储方向的像素
  // ——用它建画布会让显示与导出错位（S8 修的就是这张图）。
  //
  // `.aurora` 工程不算"待初始化的图"：它的画布与图层都从文档里读出来，空工程
  // （有画布、零图层）同样如此。少了这个判断，把新建的空白文档存成工程之后，
  // `path` 一换成 `.aurora` 就会触发这条分支去解码一个 ZIP。
  const needsInit =
    !!doc?.path && !isProjectPath(doc.path) && (!canvas || layerCount === 0);
  const initStartedRef = useRef<string | null>(null);
  /**
   * 已经**初始化成功**过的路径。
   *
   * 为什么不能只靠 `needsInit`：它的判据里有 `layerCount === 0`（刚打开时图层还没建），
   * 而「删掉最后一个图层」也会让图层数变成 0 —— 没有这个 ref，删空图层等于
   * **立刻把刚删的那张图原样建回来**（图层面板一上线就会撞到）。
   *
   * 只在成功后写，且清理时不复位（复位就退化成 `initStartedRef`，又会重新初始化）；
   * 一个 Tab 恒等于一个文档，同一实例内路径不变，所以它不会挡住本该重来的初始化。
   */
  const initDoneRef = useRef<string | null>(null);

  useEffect(() => {
    if (!doc?.path || !needsInit) return;
    if (initStartedRef.current === doc.path) return;
    // 已成功建过图层：图层数变 0 是用户删的，不是"还没初始化"
    if (initDoneRef.current === doc.path) return;
    initStartedRef.current = doc.path;

    let cancelled = false;
    loadLayerProxy(doc.path)
      .then(res => {
        if (cancelled) return;
        const m = orientationToBox(
          { width: res.naturalWidth, height: res.naturalHeight },
          res.orientation,
        );
        // 画布 = **转正后**的显示尺寸；图层自己带 rotation/flip 去对齐
        const nextCanvas = createCanvas(m.displayWidth, m.displayHeight, 'transparent');
        const layer = createOrientedImageLayer({
          id: createLayerId(),
          source: doc.path,
          naturalWidth: res.naturalWidth,
          naturalHeight: res.naturalHeight,
          orientation: res.orientation,
          canvas: nextCanvas,
          name: doc.name,
        });
        // 顺手把代理塞进缓存：缩略图与全览图马上要用，省一次 IPC
        putPreview(`${doc.path}#${res.naturalWidth}x${res.naturalHeight}`, {
          width: res.naturalWidth,
          height: res.naturalHeight,
          previewWidth: res.previewWidth,
          previewHeight: res.previewHeight,
          dataUrl: res.dataUrl,
        });
        setError(null);
        initDoneRef.current = doc.path ?? null; // 建过一次就不再自动重建（见 initDoneRef 说明）
        onDocumentChange({
          ...doc,
          version: EDITOR_DOC_VERSION,
          canvas: nextCanvas,
          layers: [layer],
          activeLayerId: layer.id,
          dirty: doc.dirty, // 初始化不算改动，不置 dirty
        });
      })
      .catch(e => {
        if (!cancelled) setError(String(e));
      });

    return () => {
      cancelled = true;
      /**
       * ⚠️ **必须在清理时把标记清掉**。
       *
       * `main.tsx` 开着 `React.StrictMode`，dev 下 effect 会「挂载 → 清理 → 再挂载」。
       * 若这里保留 `initStartedRef`，第 2 次 effect 会被 ref 直接挡回去，而第 1 次的
       * promise 又因 `cancelled` 把结果丢掉 —— 初始化永远不完成，表现为画布一直停在
       * 「正在打开…」且尺寸 0×0（实测踩过）。
       *
       * 清掉之后第 2 次会重新发起；第 1 次的过期结果仍由 `cancelled` 拦住，不会重复建层。
       */
      if (initStartedRef.current === doc.path) initStartedRef.current = null;
    };
  }, [doc, needsInit, onDocumentChange]);

  // ---- 缩略图用的 Rust 代理 ----
  //
  // 画布主显示走原文件，但右侧面板的图层行 / 全览图需要一张**小图**：从原图直接缩到
  // 96/320px 是一次几十倍的低质降采样（满屏锯齿），所以用 Rust 那张 ≤2048 的代理。
  // 这也是 §4.4 给代理分配的新角色（缩略图 + 超大图打底）。
  const proxyKey = activeLayer ? buildLayerPreviewKey(activeLayer) : null;
  useEffect(() => {
    if (!proxyKey || !activeLayer?.source) return;
    if (takePreview(proxyKey)) return;
    let cancelled = false;
    // 与初始化共用同一个请求（`loadLayerProxy` 按路径去重），不会为了缩略图再解一次
    loadLayerProxy(activeLayer.source)
      .then(res => {
        if (cancelled) return;
        putPreview(proxyKey, {
          width: res.naturalWidth,
          height: res.naturalHeight,
          previewWidth: res.previewWidth,
          previewHeight: res.previewHeight,
          dataUrl: res.dataUrl,
        });
      })
      .catch(() => {
        /* 缩略图失败不影响编辑，面板会退回图标占位 */
      });
    return () => {
      cancelled = true;
    };
  }, [proxyKey, activeLayer?.source]);

  // 缓存被刷新时（订阅驱动）让面板能拿到新缩略图
  useSyncExternalStore(subscribePreview, () => (proxyKey ? peekPreview(proxyKey) : undefined));

  // ---- 视图 ----
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

  // ---- 裁剪：改画布尺寸（非破坏性）----
  useEffect(() => {
    if (tool !== 'crop' || !canvas) {
      setCropRect(null);
      return;
    }
    setCropRect({ x: 0, y: 0, w: canvas.width, h: canvas.height });
  }, [tool, canvas]);

  const [cropRatio, setCropRatio] = useState<number | null>(null);

  /** 吸附开关（工具选项条上的那个）；默认开，与 PS 的「视图 > 对齐」同义 */
  const [snapEnabled, setSnapEnabled] = useState(true);

  /**
   * 图层是否处于"被选中"状态（只影响那圈蓝框）。
   *
   * 打开文档时**不选中**——什么都没点却顶着一圈边框，看起来像已经选了图层
   * （用户实测反馈）。点图层选中、点画布空白取消；自由变换态恒为选中，
   * 否则刚拖出来的框会在松手前消失。
   */
  const [layerSelected, setLayerSelected] = useState(false);

  const handleCropRatioChange = useCallback(
    (ratio: number | null) => {
      setCropRatio(ratio);
      if (!ratio || !canvas) return;
      setCropRect(prev => {
        if (!prev || canvas.height === 0) return prev;
        const cx = prev.x + prev.w / 2;
        const cy = prev.y + prev.h / 2;
        let w = prev.w;
        let h = w / ratio;
        if (h > canvas.height) {
          h = canvas.height;
          w = h * ratio;
        }
        if (w > canvas.width) {
          w = canvas.width;
          h = w / ratio;
        }
        return {
          x: Math.min(Math.max(cx - w / 2, 0), Math.max(0, canvas.width - w)),
          y: Math.min(Math.max(cy - h / 2, 0), Math.max(0, canvas.height - h)),
          w: Math.round(w),
          h: Math.round(h),
        };
      });
    },
    [canvas],
  );

  /**
   * 提交裁剪 = **改画布尺寸 + 所有图层反向平移**。
   *
   * 非破坏性：像素一个都不裁掉，图层只是露在画布外面被 `overflow:hidden` 挡住。
   * 导出按画布尺寸合成，所以成品与"真裁掉"完全一致；而 Ctrl+Z 能把画布改回去、内容还在。
   */
  const commitCrop = useCallback(() => {
    if (!cropRect || !doc || !canvas) return;
    const w = Math.round(cropRect.w);
    const h = Math.round(cropRect.h);
    if (w < 1 || h < 1) return;
    const dx = Math.round(cropRect.x);
    const dy = Math.round(cropRect.y);
    onDocumentChange({
      ...doc,
      canvas: { ...canvas, width: w, height: h },
      layers: (doc.layers ?? []).map(l => ({
        ...l,
        box: { ...l.box, x: l.box.x - dx, y: l.box.y - dy },
      })),
      dirty: true,
    });
    onToolChange('move');
  }, [cropRect, doc, canvas, onDocumentChange, onToolChange]);

  const cancelCrop = useCallback(() => onToolChange('move'), [onToolChange]);

  // ---- 旋转 / 翻转（画布级，一次性换算）----
  //
  // 不留"文档转过 90°"的常驻字段：算完之后画布就是 H×W、图层就以新角度摆在上面，
  // 全程只有一个角度可读（设计稿 §5.1）。
  const handleRotate = useCallback(
    (clockwise: boolean) => {
      if (!doc || !canvas) return;
      const boxes = (doc.layers ?? []).map(l => l.box);
      const out = rotateDocumentCanvas(canvas, boxes, clockwise);
      onDocumentChange({
        ...doc,
        canvas: { ...canvas, ...out.canvas },
        layers: (doc.layers ?? []).map((l, i) => ({ ...l, box: out.layers[i] })),
        dirty: true,
      });
    },
    [doc, canvas, onDocumentChange],
  );

  const handleFlip = useCallback(
    (horizontal: boolean) => {
      if (!doc || !canvas) return;
      const boxes = (doc.layers ?? []).map(l => l.box);
      const out = flipDocumentCanvas(canvas, boxes, horizontal, !horizontal);
      onDocumentChange({
        ...doc,
        canvas: { ...canvas, ...out.canvas },
        layers: (doc.layers ?? []).map((l, i) => ({ ...l, box: out.layers[i] })),
        dirty: true,
      });
    },
    [doc, canvas, onDocumentChange],
  );

  /** 调色是**图层属性**（设计稿 §4.1），落在当前活动图层上 */
  const handleAdjustChange = useCallback(
    (next: NonNullable<EditorLayer['adjust']>) => {
      if (!doc || !activeLayer) return;
      onDocumentChange({
        ...doc,
        layers: (doc.layers ?? []).map(l => (l.id === activeLayer.id ? { ...l, adjust: next } : l)),
        dirty: true,
      });
    },
    [doc, activeLayer, onDocumentChange],
  );

  const commitCropRef = useRef(commitCrop);
  commitCropRef.current = commitCrop;
  const cancelCropRef = useRef(cancelCrop);
  cancelCropRef.current = cancelCrop;

  // ---- 自由变换（Ctrl+T）----
  //
  // 交互层直接复用参考模式的 `EditOverlay`（八向缩放 / 四角旋转 / 对角锚定缩放数学
  // 都在里面，2.2.1 已验收）。编辑器这边只做三处适配：
  //   1. 坐标原点 = 画布左上（comparer 是无限桌面），画布容器已经 overflow:hidden；
  //   2. 选中项 = 活动图层；
  //   3. 吸附目标额外加上画布四边与中心（`snapBounds`，只传了活动图层，
  //      没有别的项可对齐）。
  // 变换结果写回 layer.box，预览靠 CSS、导出靠同一组矩阵，不经过 Rust 往返。
  const transformStartRef = useRef<LayerBox | null>(null);

  useEffect(() => {
    if (tool === 'transform' && activeLayer) {
      if (!transformStartRef.current) transformStartRef.current = activeLayer.box;
    } else {
      transformStartRef.current = null;
    }
  }, [tool, activeLayer]);

  const overlayItem = useMemo((): ComparisonItem | null => {
    if (!activeLayer) return null;
    const b = activeLayer.box;
    return {
      id: activeLayer.id,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      rotation: b.rotation,
      src: activeLayer.source ?? '',
      opacity: 1,
    };
  }, [activeLayer]);

  /** `EditOverlay` 的字段名（x/width/height）→ 图层的定界框字段（x/w/h） */
  const handleOverlayUpdate = useCallback(
    (_id: string, updates: Partial<ComparisonItem>) => {
      if (!doc || !activeLayer) return;
      const box: LayerBox = { ...activeLayer.box };
      if (updates.x !== undefined) box.x = updates.x;
      if (updates.y !== undefined) box.y = updates.y;
      if (updates.width !== undefined) box.w = updates.width;
      if (updates.height !== undefined) box.h = updates.height;
      if (updates.rotation !== undefined) box.rotation = updates.rotation;
      onDocumentChange({
        ...doc,
        layers: (doc.layers ?? []).map(l => (l.id === activeLayer.id ? { ...l, box } : l)),
        dirty: true,
      });
    },
    [doc, activeLayer, onDocumentChange],
  );

  /** Esc 取消本次变换：把定界框还原到进入变换时的样子（PS 行为） */
  const cancelTransform = useCallback(() => {
    const start = transformStartRef.current;
    if (start && doc && activeLayer) {
      onDocumentChange({
        ...doc,
        layers: (doc.layers ?? []).map(l => (l.id === activeLayer.id ? { ...l, box: start } : l)),
        dirty: true,
      });
    }
    onToolChange('move');
  }, [doc, activeLayer, onDocumentChange, onToolChange]);

  const cancelTransformRef = useRef(cancelTransform);
  cancelTransformRef.current = cancelTransform;

  // ---- 导入图层 ----
  //
  // 从任意文件系统路径导入（不受资源根限制）。自然尺寸与 EXIF 方向都问 Rust
  // （与开文档同一条路），浏览器只负责画像素。默认按 contain 居中落位（§10 第 5 条已拍板）。
  const handleImportLayer = useCallback(async () => {
    if (!doc || !canvas) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: '图片',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico'],
          },
        ],
      });
      if (!picked || typeof picked !== 'string') return;

      // 与开文档同一条路：尺寸与 EXIF 方向都问 Rust，浏览器只负责画像素
      const res = await loadLayerProxy(picked);
      const layer = createOrientedImageLayer({
        id: createLayerId(),
        source: picked,
        naturalWidth: res.naturalWidth,
        naturalHeight: res.naturalHeight,
        orientation: res.orientation,
        canvas,
      });
      putPreview(`${picked}#${res.naturalWidth}x${res.naturalHeight}`, {
        width: res.naturalWidth,
        height: res.naturalHeight,
        previewWidth: res.previewWidth,
        previewHeight: res.previewHeight,
        dataUrl: res.dataUrl,
      });
      onDocumentChange({
        ...doc,
        version: EDITOR_DOC_VERSION,
        canvas,
        layers: [...(doc.layers ?? []), layer],
        activeLayerId: layer.id,
        dirty: true,
      });
    } catch (e) {
      setError(String(e));
    }
  }, [doc, canvas, onDocumentChange]);

  // ---- 导出 ----
  const [exportState, setExportState] = useState<{
    status: 'idle' | 'working' | 'done' | 'error';
    text?: string;
  }>({ status: 'idle' });

  const handleExport = useCallback(async () => {
    if (!doc || !canvas) return;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const raw = doc.path ?? '';
      const sepIdx = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
      const sep = sepIdx >= 0 ? raw[sepIdx] : '\\';
      const dir = sepIdx >= 0 ? raw.slice(0, sepIdx) : '';
      const base = doc.name.replace(/\.[^.]+$/, '');

      const target = await save({
        filters: [
          { name: 'PNG', extensions: ['png'] },
          { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
          { name: 'WebP（无损）', extensions: ['webp'] },
        ],
        defaultPath: `${dir}${sep}${base}_编辑.png`,
      });
      if (!target) return;

      setExportState({ status: 'working' });
      // 与预览**同一组矩阵六参**：前端算的矩阵原样交给 Rust，两端不各推一次。
      // 这是"所见即所得"的保证——顺序/公式只存在一份（layerTransform.ts）。
      const res = await invoke<{ path: string; width: number; height: number; bytes: number }>(
        'editor_export_document',
        {
          doc: {
            canvas: {
              width: canvas.width,
              height: canvas.height,
              background: canvas.background,
            },
            layers: (doc.layers ?? [])
              // 关掉的眼睛在成品里必须也是关的：Rust 的合成只按数组逐层画，
              // 它不知道"可见性"这件事（`DocumentRequest` 里根本没有这个字段）。
              .filter(l => l.source && l.visible)
              .map(l => ({
                path: l.source,
                matrix: composeMatrix(l.box, { width: l.naturalWidth, height: l.naturalHeight }),
                adjust: l.adjust ?? null,
                // 百分比原样给 Rust（它按 alpha 缩放落地，见 imaging::opacity）
                opacity: layerOpacity(l),
                // 混合模式原样给 Rust（名字与 CSS 同名，见 blendModes.ts）
                blend: layerBlend(l),
              })),
          },
          targetPath: target,
        },
      );
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
  }, [doc, canvas, onFileCreated]);

  // ---- 工程文件（.aurora）：保存 / 另存为 / 打开 ----
  //
  // 读写全在 Rust（`core/src/editor_project.rs`）：前端只传**语义参数**（定界框 +
  // 调色）和目标路径，图片字节不进 WebView。打开时 Rust 把图层图解到系统临时目录，
  // 回传路径，画布照旧走 `convertFileSrc` 显示原文件。
  const [notice, setNotice] = useState<{
    status: 'idle' | 'working' | 'done' | 'error';
    text?: string;
  }>({ status: 'idle' });
  const noticeTimerRef = useRef<number | null>(null);

  /** 短暂提示条：5 秒后自动收（保存结果、打开时的警告都走它）。 */
  const flashNotice = useCallback(
    (next: { status: 'done' | 'error'; text: string }, ttl = 5000) => {
      setNotice(next);
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = window.setTimeout(() => setNotice({ status: 'idle' }), ttl);
    },
    [],
  );

  useEffect(
    () => () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  /** 保存工程（对话框 + IPC 在 `projectIo.ts`，与顶栏入口共用同一套流程）。 */
  const handleSaveProject = useCallback(
    async (saveAs: boolean) => {
      if (!doc || !canvas || notice.status === 'working') return;
      try {
        setNotice({ status: 'working' });
        const outcome = await saveProject(doc, saveAs);
        if (!outcome) {
          setNotice({ status: 'idle' }); // 用户取消：不要把"正在保存"留在条上
          return;
        }
        onDocumentChange(outcome.document);
        const { report } = outcome;
        const dedup =
          report.dedupedBytes > 0 ? ` · 去重省 ${formatBytes(report.dedupedBytes)}` : '';
        flashNotice({
          status: 'done',
          text: `已保存 ${formatBytes(report.bytes)} · ${report.layerCount} 图层 / ${report.imageCount} 图${dedup}`,
        });
      } catch (e) {
        flashNotice({ status: 'error', text: String(e) }, 8000);
      }
    },
    [doc, canvas, notice.status, onDocumentChange, flashNotice],
  );

  const handleOpenProject = useCallback(async () => {
    try {
      const outcome = await openProjectDialog();
      if (!outcome) return;
      onOpenProject?.(outcome.document);
      if (outcome.warnings.length) {
        flashNotice(
          {
            status: 'done',
            text: `已打开 · ${outcome.warnings.length} 处提示：${outcome.warnings.join('；')}`,
          },
          9000,
        );
      }
    } catch (e) {
      // 打开失败不该占用当前文档的任何状态，用提示条报，不写进画布的错误浮层
      flashNotice({ status: 'error', text: String(e) }, 8000);
    }
  }, [onOpenProject, flashNotice]);

  /**
   * 删除活动图层（Del 键与面板上的删除按钮走同一条路）。
   *
   * 面板里的删除按钮在另一棵子树（`RightPanel`），那边自己算好新数组交给 App；
   * 这里给键盘用，语义与 `layerModel.removeLayer` 完全一致（删完活动层落到下面那层）。
   */
  const handleDeleteActiveLayer = useCallback(() => {
    if (!doc) return;
    const active = resolveActiveLayer(doc);
    if (!active) return;
    const r = removeLayer(doc.layers ?? [], active.id, doc.activeLayerId);
    if (r.layers === (doc.layers ?? [])) return;
    onDocumentChange({ ...doc, layers: r.layers, activeLayerId: r.activeLayerId, dirty: true });
  }, [doc, onDocumentChange]);

  // 快捷键要能读到最新的 handler，而键盘 effect 只依赖 `onToolChange`（重挂监听会让
  // 拖拽中的按键状态错乱），所以走 ref
  const saveProjectRef = useRef(handleSaveProject);
  saveProjectRef.current = handleSaveProject;
  const openProjectRef = useRef(handleOpenProject);
  openProjectRef.current = handleOpenProject;
  const deleteLayerRef = useRef(handleDeleteActiveLayer);
  deleteLayerRef.current = handleDeleteActiveLayer;

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

  // ---- 键盘 ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return;
      if (isTextEditingTarget(e.target)) return;
      // 新建文档弹窗开着时，按键只归弹窗（Esc 它自己 capture 处理）——
      // 不挡的话 V/C 这些快捷键会"穿透"弹窗改掉背后的工具（用户实测踩到）
      if (showNewDocRef.current) return;

      if (e.code === 'Space') {
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        e.preventDefault();
        return;
      }
      if (e.key === 'Alt') {
        altHeldRef.current = true;
        setAltHeld(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoRef.current();
        else undoRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoRef.current();
        return;
      }
      // Ctrl+S / Ctrl+Shift+S / Ctrl+O：存工程与开工程（PS 的键位口径）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProjectRef.current(e.shiftKey);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProjectRef.current();
        return;
      }
      // Ctrl+T：进入/退出自由变换（PS 行为）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        onToolChange(toolRef.current === 'transform' ? 'move' : 'transform');
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

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

      // 自由变换：Enter 提交 / Esc 取消（PS 行为）
      if (toolRef.current === 'transform') {
        if (e.key === 'Enter') {
          onToolChange('move');
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          cancelTransformRef.current();
          e.preventDefault();
          return;
        }
      }

      /**
       * Delete = 删除活动图层（PS 行为）。只认 `Delete`，不认 `Backspace`：
       * 后者在阅读/编辑时太容易误触，而 `isTextEditingTarget` 只能挡住输入框里的按键。
       *
       * 裁剪与自由变换状态下不抢这个键——那两个状态里没有"删图层"的语义，
       * 抢了反而会让人在调整构图时把图层删掉。
       */
      if (e.key === 'Delete' && toolRef.current !== 'crop' && toolRef.current !== 'transform') {
        e.preventDefault();
        deleteLayerRef.current();
        return;
      }

      const next = EDITOR_SHORTCUT_KEYS[e.key.toLowerCase()];
      if (next) {
        // 同一个工具的快捷键再按一次 = 取消选择（不选任何工具）
        onToolChange(toolRef.current === next ? null : next);
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

  // ---- 鼠标 ----
  // `null` = 没选工具：光标普通箭头、点画布什么都不发生（滚轮/空格平移仍可用）
  const effectiveTool: EditorToolId | null = spaceHeld ? 'hand' : tool;

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;

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

    // 移动工具：点空白处取消选中；点在**别的图层**上就换成那一层（PS 的"点哪层选哪层"）。
    //
    // 只在"没点中活动层"时才做命中测试：点中活动层时 `EditOverlay` 的拖动层已经在拖它了，
    // 这时候再改选区就会变成"拖的是 A、选中的是 B"。
    if (effectiveTool === 'move') {
      const el = containerRef.current;
      if (el && activeLayer) {
        const rect = el.getBoundingClientRect();
        const cx = (e.clientX - rect.left - transform.x) / transform.scale;
        const cy = (e.clientY - rect.top - transform.y) / transform.scale;
        if (!pointInBox(activeLayer.box, cx, cy)) {
          // 自顶向下取第一个命中的**可见**图层（数组自底向上，所以倒着扫）。
          // 自动选择 = 无 时不做这一步：点别的层不换选中层，换层只走图层面板。
          let hit: EditorLayer | undefined;
          if (autoSelect === 'layer') {
            for (let i = layers.length - 1; i >= 0; i -= 1) {
              const l = layers[i];
              if (l.source && l.visible && pointInBox(l.box, cx, cy)) {
                hit = l;
                break;
              }
            }
          }
          if (hit) {
            setLayerSelected(true);
            // 只换选区：不置 dirty、不进撤销栈（签名里没有 activeLayerId）。
            // 这一下**不开始拖动**——`EditOverlay` 只在按到活动层框内时才捕获拖动，
            // 所以点别的层就是纯粹的"选中"，要拖它得再按一次（与 PS 一致）。
            if (doc && hit.id !== activeLayer.id) {
              onDocumentChange({ ...doc, activeLayerId: hit.id });
            }
          } else {
            setLayerSelected(false);
          }
        }
      }
      return;
    }

    // 只有抓手平移视图。移动工具留给自由变形——它该移的是**图层**，不是视口。
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

  // 图层的 CSS 变换：定界框 + 自然尺寸 → 六参 → matrix()
  const buildLayerStyle = useCallback(
    (layer: EditorLayer): React.CSSProperties => {
      const m = composeMatrix(layer.box, {
        width: layer.naturalWidth,
        height: layer.naturalHeight,
      });
      const filterOn = !isZeroAdjustments(layer.adjust);
      return {
        position: 'absolute',
        left: 0,
        top: 0,
        width: layer.naturalWidth,
        height: layer.naturalHeight,
        // transform-origin 必须是 0 0：矩阵是在"内容像素坐标"里算的
        transformOrigin: '0 0',
        transform: toCssMatrix(m),
        filter: filterOn ? `url(#${layerFilterId(layer.id)})` : undefined,
        // 预览直接吃 CSS 的 `mix-blend-mode`：名字与 Rust 侧同一套字符串，
        // 所以这一行同时就是"导出会怎么混"的承诺（画布容器已 isolation，见渲染处注释）
        mixBlendMode: layerBlend(layer),
        // 可见性与不透明度合成同一个 CSS 值：隐藏 = 0，其余按百分比。
        // （隐藏用 opacity 而不是 display:none，是为了保留 <img> 的解码结果，切回来不闪）
        opacity: layer.visible ? layerOpacity(layer) / 100 : 0,
        /**
         * **必须关掉浏览器的 EXIF 自动转正**。
         *
         * 图层方向已经由 `orientationToBox` 折进 rotation/flip 了；如果这里
         * 让浏览器再转一次，就变成"转两遍"，而且 Rust 导出只按我们的变换算 ——
         * 结果是屏幕和导出对不上。这是 S8 的核心那一行。
         */
        imageOrientation: 'none',
        // Tailwind preflight 给所有 img 设了 max-width:100%，必须顶回去
        maxWidth: 'none',
        maxHeight: 'none',
      };
    },
    // layerFilterId 只依赖 tabId
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabId],
  );

  // 透明用棋盘格——PS 的通用表达，用户一眼知道"这里没东西"。
  //
  // ⚠️ 格子必须是**屏幕空间固定大小**：这个 div 带着 `scale(transform.scale)`，
  // 如果 background-size 写死 16px，缩小到 25% 时一个格子只剩 4 个屏幕像素，
  // 密到糊成一片灰（用户实测："看起来像一块灰色的密密麻麻的东西"）。
  // 所以按缩放**反向补偿**，让格子永远 16 个屏幕像素。
  const checkerScale = transform.scale > 0 ? transform.scale : 1;
  const checkerSize = `${16 / checkerScale}px ${16 / checkerScale}px`;
  const isTransparentBg = !canvas?.background || canvas.background === 'transparent';

  const docName = doc?.name || '未命名';
  const isReady = !!canvas;
  const legacy = isLegacyEditorDocument(doc);

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden bg-neutral-100 dark:bg-neutral-900">
      <svg className="absolute w-0 h-0 pointer-events-none" aria-hidden="true">
        {/* 活动图层的那一份，右侧面板的缩略图按这个 id 引用 */}
        <filter id={adjustFilterId} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={adjustValues} />
        </filter>
        {/* 画布上每层各一份，互不干扰 */}
        {layerFilters
          .filter(f => f.on)
          .map(f => (
            <filter key={f.id} id={f.id} colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values={f.values} />
            </filter>
          ))}
      </svg>

      {legacy && (
        <div className="px-3 py-1.5 text-[11px] bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 shrink-0">
          这是旧版编辑文档，已无法继续编辑——请重新打开这张图片。
        </div>
      )}

      {/* 文档栏：画布级 / 文档级快捷操作（设计稿 §10.1） */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 select-none">
        <button
          type="button"
          onClick={onToggleSidebar}
          className={`p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 ${isSidebarVisible ? 'text-blue-500' : ''}`}
          title="切换左侧面板"
        >
          <Sidebar size={15} />
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
        <button
          type="button"
          onClick={() => setShowNewDoc(true)}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700"
          title="新建空白文档"
        >
          <FilePlus size={15} />
        </button>
        <button
          type="button"
          onClick={handleOpenProject}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700"
          title="打开工程 (.aurora) — Ctrl+O"
        >
          <FolderOpen size={15} />
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
        <button
          type="button"
          onClick={handleImportLayer}
          disabled={!canvas}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
          title="导入图层（任意路径的图片）"
        >
          <ImagePlus size={15} />
        </button>
        <button
          type="button"
          onClick={() => handleSaveProject(false)}
          disabled={!canvas || notice.status === 'working'}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
          title="保存工程 (Ctrl+S)"
        >
          {notice.status === 'working' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
        </button>
        <button
          type="button"
          onClick={() => handleSaveProject(true)}
          disabled={!canvas || notice.status === 'working'}
          className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40"
          title="另存为工程 (Ctrl+Shift+S)"
        >
          <SaveAll size={15} />
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
        {/* 未保存圆点：标签栏没有这个标记，文档栏得自己说清楚 */}
        {doc?.dirty && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
            title="有未保存的改动"
          />
        )}
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100 truncate max-w-[30%]">
          {docName}
        </span>
        {canvas && (
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400 shrink-0 tabular-nums">
            画布 {canvas.width}×{canvas.height}
          </span>
        )}
        {notice.status === 'done' && (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0 truncate max-w-[24rem]" title={notice.text}>
            {notice.text}
          </span>
        )}
        {notice.status === 'error' && (
          <span className="text-[11px] text-red-500 shrink-0 max-w-[20rem] truncate" title={notice.text}>
            {notice.text}
          </span>
        )}
        {exportState.status === 'done' && (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0">
            {exportState.text}
          </span>
        )}
        {exportState.status === 'error' && (
          <span className="text-[11px] text-red-500 shrink-0 max-w-[20rem] truncate" title={exportState.text}>
            {exportState.text}
          </span>
        )}
        <div className="flex-1" />
        <button type="button" onClick={undo} disabled={!canUndo} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="撤销 (Ctrl+Z)">
          <Undo2 size={15} />
        </button>
        <button type="button" onClick={redo} disabled={!canRedo} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="重做 (Ctrl+Shift+Z)">
          <Redo2 size={15} />
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />
        <button type="button" onClick={() => handleRotate(false)} disabled={!isReady} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="逆时针旋转画布 90°">
          <RotateCcw size={15} />
        </button>
        <button type="button" onClick={() => handleRotate(true)} disabled={!isReady} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="顺时针旋转画布 90°">
          <RotateCw size={15} />
        </button>
        <button type="button" onClick={() => handleFlip(true)} disabled={!isReady} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="水平翻转画布">
          <FlipHorizontal2 size={15} />
        </button>
        <button type="button" onClick={() => handleFlip(false)} disabled={!isReady} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="垂直翻转画布">
          <FlipVertical2 size={15} />
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />
        <button type="button" onClick={handleExport} disabled={!isReady || exportState.status === 'working'} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="导出为图片（PNG / JPEG / WebP）">
          {exportState.status === 'working' ? <Loader2 size={15} className="animate-spin" /> : <FileOutput size={15} />}
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />
        <button type="button" onClick={() => zoomAtCenter(1 / CLICK_ZOOM_STEP)} disabled={!isReady} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="缩小">
          <ZoomOut size={15} />
        </button>
        <span className="text-[11px] tabular-nums text-neutral-600 dark:text-neutral-300 w-11 text-center">
          {Math.round(transform.scale * 100)}%
        </span>
        <button type="button" onClick={() => zoomAtCenter(CLICK_ZOOM_STEP)} disabled={!isReady} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="放大">
          <ZoomIn size={15} />
        </button>
        <button type="button" onClick={fitToView} disabled={!isReady} className="p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-40" title="查看全部">
          <Scan size={15} />
        </button>
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700" />
        <button type="button" onClick={onToggleMetadata} className={`p-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 ${isMetadataVisible ? 'text-blue-500' : ''}`} title="切换右侧面板">
          <PanelRight size={15} />
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        <EditorToolbar
          activeTool={spaceHeld ? 'hand' : tool}
          onSelect={t => onToolChange(t === tool ? null : t)}
          disabled={!doc}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <EditorOptionsBar
            tool={spaceHeld ? 'hand' : tool}
            scale={transform.scale}
            onZoomTo={zoomTo}
            onFit={fitToView}
            cropRect={cropRect}
            onCropCommit={commitCrop}
            onCropCancel={cancelCrop}
            cropRatio={cropRatio}
            docAspect={canvas && canvas.height > 0 ? canvas.width / canvas.height : undefined}
            onCropRatioChange={handleCropRatioChange}
            layerBox={activeLayer?.box}
            snapEnabled={snapEnabled}
            onSnapToggle={setSnapEnabled}
            autoSelect={autoSelect}
            onAutoSelectChange={setAutoSelect}
            onLayerBoxChange={patch => {
              if (!doc || !activeLayer) return;
              onDocumentChange({
                ...doc,
                layers: (doc.layers ?? []).map(l =>
                  l.id === activeLayer.id ? { ...l, box: { ...l.box, ...patch } } : l,
                ),
                dirty: true,
              });
            }}
          />

          {/* 画布（视口） */}
          <div
            ref={containerRef}
            className="flex-1 relative overflow-hidden"
            style={{ cursor }}
            onMouseDown={onMouseDown}
            onDoubleClick={fitToView}
          >
            {error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center pointer-events-none">
                <AlertTriangle size={22} className="text-amber-500" />
                <span className="text-sm text-neutral-700 dark:text-neutral-200">无法打开这张图</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400 break-all max-w-lg">{error}</span>
              </div>
            )}

            {/* 画布容器：图层超出这里的部分被裁掉，这就是"裁剪"的全部实现 */}
            {canvas && !error && (
              <div
                className="absolute"
                style={{
                  left: 0,
                  top: 0,
                  width: canvas.width,
                  height: canvas.height,
                  transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
                  transformOrigin: '0 0',
                  overflow: 'hidden',
                  backgroundColor:
                    canvas.background === 'black'
                      ? '#000000'
                      : canvas.background === 'white'
                        ? '#ffffff'
                        : '#ffffff',
                  backgroundImage: isTransparentBg
                    ? 'repeating-conic-gradient(#d0d0d0 0% 25%, #ffffff 0% 50%)'
                    : undefined,
                  backgroundSize: isTransparentBg ? checkerSize : undefined,
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                }}
              >
                {/*
                  图层**混合组**：`isolation: isolate` 把 `mix-blend-mode` 的作用范围
                  锁在组内——否则最底下那层会跟画布外的棋盘格/应用背景混在一起。

                  白/黑底**画在组内**（它参与混合，与 Rust 先铺背景再叠层的顺序一致）；
                  透明底的棋盘格留在组外——它只是"这里没东西"的装饰，不该被混。
                */}
                <div className="absolute inset-0" style={{ isolation: 'isolate' }}>
                  {!isTransparentBg && (
                    <div
                      className="absolute inset-0"
                      style={{
                        backgroundColor: canvas.background === 'black' ? '#000000' : '#ffffff',
                      }}
                    />
                  )}
                  {/* 自底向上渲染；多图层是"白送的"——Rust 合成早就按数组写了 */}
                  {layers.map(l =>
                    l.source ? (
                      <img
                        key={l.id}
                        src={convertFileSrc(l.source)}
                        alt={l.name}
                        draggable={false}
                        style={buildLayerStyle(l)}
                        onError={() => setError(`无法打开图层「${l.name}」`)}
                      />
                    ) : null,
                  )}
                </div>
              </div>
            )}

            {/* 初始化中：尺寸与方向要从 Rust 拿（见上面的 init effect） */}
            {needsInit && !canvas && !error && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-500 pointer-events-none">
                <Loader2 size={18} className="animate-spin" />
                <span className="text-sm">正在打开…</span>
              </div>
            )}

            {/* 自由变换 / 移动：直接复用参考模式的 EditOverlay。
                移动工具也能拖图层（v1 里它无事可做，只能伪装成抓手）。 */}
            {/* 用 effectiveTool 而不是 tool：按住空格时这里是 'hand'，overlay 必须**卸载**——
                它盖在画布上自己的指针逻辑会拖图层，抢在容器平移之前（用户实测：
                鼠标在图上按空格，出来的不是抓手而是图层被拖走） */}
            {(effectiveTool === 'move' || effectiveTool === 'transform') && overlayItem && canvas && !error && (
              <EditOverlay
                activeItem={overlayItem}
                selectedItems={[overlayItem]}
                allItems={[overlayItem]}
                transform={transform}
                onUpdateItem={handleOverlayUpdate}
                onRemoveItem={() => {}}
                containerRef={containerRef}
                isSnappingEnabled={snapEnabled}
                snapBounds={{ width: canvas.width, height: canvas.height }}
                // 编辑态恒为 true：移动工具也要能拖动图层（拖动层由 canDragLayer 控制）
                isEditMode
                // 手柄只在自由变换时出现——移动工具只显示边界，PS 也是这样
                showTransformHandles={tool === 'transform'}
                // 移动工具下"点一下才算选中"：未选中不画边框
                showChrome={tool === 'transform' || layerSelected}
                onInteractionStart={() => setLayerSelected(true)}
                isDarkMode={document.documentElement.classList.contains('dark')}
              />
            )}

            {canvas && !error && effectiveTool === 'crop' && (
              <CropOverlay
                docWidth={canvas.width}
                docHeight={canvas.height}
                // 画布坐标 = 文档坐标，投影比例恒为 1——不再有"代理倍率"这一层
                proxyScale={1}
                transform={transform}
                rect={cropRect}
                aspectRatio={cropRatio}
                onChange={setCropRect}
              />
            )}
          </div>

          <EditorStatusBar
            tool={tool}
            scale={transform.scale}
            width={canvas?.width ?? 0}
            height={canvas?.height ?? 0}
            spaceHeld={spaceHeld}
          />
        </div>
      </div>

      <NewDocumentDialog
        open={showNewDoc}
        onClose={() => setShowNewDoc(false)}
        onCreate={c => {
          setShowNewDoc(false);
          onNewDocument?.(c);
        }}
      />
    </div>
  );
};
