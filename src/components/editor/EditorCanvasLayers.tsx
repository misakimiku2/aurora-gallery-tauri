/**
 * 画布渲染：画布容器（overflow:hidden 负责裁切）+ 混合组 + 图层元素列表。
 *
 * 从 ImageEditor 搬出（2026-10-24 防膨胀批次 E，见进度文档 §7）——它只消费
 * canvas/transform/layers，不改任何文档状态。
 *
 * ## 像素载体（2026-10-26 架构轮 + 10-25 蒙版显示正确性轮）
 *
 * 图层像素的会话内真身在 `layerBitmaps` 位图仓：`LayerPixels` 订阅位图版本，
 * **画过的层直接渲染内存画布**（零编码、零 IPC，笔划/撤销抬手即现）；没有位图
 * （没画过）的层照旧 `<img src=convertFileSrc>` 读文件，文件路径用
 * `displaySourceOf`（位图被 LRU 逐出后回退到烘焙文件，而不是丢笔迹的原始 source）。
 * `mode='mini'`（全览图）时像素换迷你画布/代理图（`miniSources`），其余几何、
 * 蒙版、混合语义与主画布**同一份代码**——全览与画布所见即所得。
 *
 * **画过的蒙版（主画布）= `MaskedPixels` 合成画布**：图层位图 ×（蒙版位图亮度→
 * alpha）直接画进一块 canvas，位图版本驱动、useLayoutEffect 同步重画——撤销/
 * 抬笔与浏览器绘制同帧原子完成。旧的"blob URL + CSS mask-image"通路（换 URL =
 * 让浏览器重新解码 + 重栅格化 mask-image，即"撤销刷新一下/画多了刷新"的根源）
 * 已退役；CSS 壳只服务**没画过/被逐出**的蒙版（有现成文件 URL）。
 *
 * 图层混合组：`isolation: isolate` 把 `mix-blend-mode` 的作用范围锁在组内——
 * 否则最底下那层会跟画布外的棋盘格/应用背景混在一起。白/黑底**画在组内**
 * （它参与混合，与 Rust 先铺背景再叠层的顺序一致）；透明底的棋盘格留在组外——
 * 它只是"这里没东西"的装饰，不该被混。
 *
 * ## 图层元素的壳结构（2026-10-24 第二轮：蒙版解链 + 剪贴蒙版）
 *
 * 一个图层元素从外到内可能有三种壳，各自负责一件事：
 *
 * ```
 * C 剪贴壳（仅 clipped 层）：transform = M_base，mask-image = 基础层图（alpha 模式）
 *   A 蒙版壳（仅未作画蒙版的层）：transform = M_mask，mask-image = 蒙版文件（luminance
 *     模式），尺寸/矩阵由 maskShellSpec 给出（链接 = 图层内容框、蒙版拉伸；
 *     解链 = 蒙版自己的框）——画过的蒙版不走壳，见 MaskedPixels
 *     B 内容壳：transform = inv(M_mask)·M_layer（外链在外层壳上抵消，见下）
 *       <img>/<canvas> 图层像素，1:1 自然尺寸、无变换
 * ```
 *
 * 坐标换算的通式：**想让某壳/元素在画布空间呈矩阵 M，而它挂在合成矩阵为 Q 的
 * 外链下，就给它 `inv(Q)·M`**（`multiplyAffine(invertAffine(Q), M)`——CSS 嵌套
 * 里外层变换作用在子元素变换的结果上）。B 壳的外链是 A，Q = M_mask。
 * 蒙版链接时 M_mask = M_layer，A/B 退化成"原样 + 恒等"，与第一轮"mask 直接
 * 挂 img"逐像素等价。
 *
 * 已知取舍（进度文档 §6）：带 transform 的壳自成 stacking context，**剪贴层挂
 * 非 normal 混合模式时 CSS 预览近似**（隔离后只与壳内合成）；Rust 导出精确。
 * normal 模式（绝大多数）两端一致。
 */
import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { EditorCanvas, EditorLayer } from '../../types';
import {
  composeMatrix,
  invertAffine,
  maskShellSpec,
  multiplyAffine,
  toCssMatrix,
  type AffineMatrix,
} from './layerTransform';
import { isZeroAdjustments } from './colorMatrix';
import { layerBlend, layerOpacity } from './layerModel';
import {
  bitmapMeta,
  bitmapVersion,
  displaySourceOf,
  layerKey,
  maskKey,
  materializeBitmap,
  readBitmap,
  subscribeBitmaps,
} from './layerBitmaps';
import { paintTargetOf } from './brushPaint';
import { miniPixelUrlOf, miniVersionOf, peekMini, subscribeMini } from './miniSources';

/**
 * 蒙版亮度→alpha 的 SVG 滤镜 id（定义挂在 ImageEditor 的 `<svg>` 里）：
 * canvas 2D 的 `ctx.filter = url(#…)` 引用它，把"蒙版灰度"转成 alpha 再
 * destination-in 乘进图层像素——与 CSS mask luminance / Rust mask 同一套
 * sRGB 权重（0.2126/0.7152/0.0722）。
 */
export const MASK_LUM_TO_ALPHA_FILTER_ID = 'aurora-mask-lum2alpha';

const IDENTITY: AffineMatrix = [1, 0, 0, 1, 0, 0];

/**
 * 把扁平的 layers 数组切成渲染/导出用的分段：组成员段 + 组行 = 一个 group 段，
 * 其余是 flat 段。**渲染与导出共用这一份**——两边看到的结构必须完全一致，
 * 不然就是"预览一种样、导出另一种样"。
 */
export type LayerSegment =
  | { type: 'flat'; layer: EditorLayer }
  | { type: 'group'; members: EditorLayer[]; row: EditorLayer };

export function splitSegments(layers: EditorLayer[]): LayerSegment[] {
  const segments: LayerSegment[] = [];
  let i = 0;
  while (i < layers.length) {
    const gid = layers[i].groupId;
    if (gid) {
      let j = i;
      while (j < layers.length && layers[j].groupId === gid) j += 1;
      const row = layers[j];
      if (row && row.kind === 'group' && row.id === gid) {
        segments.push({ type: 'group', members: layers.slice(i, j), row });
        i = j + 1;
        continue;
      }
      // 数据损坏：成员段找不到组行——按平层渲染（导出同样处理，见 editor_commands）
    }
    segments.push({ type: 'flat', layer: layers[i] });
    i += 1;
  }
  return segments;
}

/** 剪贴簇：一个基础层 + 接在它后面的连续剪贴层（PS 的 Clipping Mask 语义）。 */
interface ClipCluster {
  base: EditorLayer;
  clipped: EditorLayer[];
}

/**
 * 按自底向上的成员序列分簇：非剪贴层开新簇当基础层，剪贴层挂进当前簇。
 * 序列开头就是剪贴层（数据损坏 / 剪贴基础层被删）时当普通层——
 * 与 Rust 侧"没有基础层的 clipped 按普通层合成"同一容错口径。
 */
function clipClusters(members: EditorLayer[]): ClipCluster[] {
  const clusters: ClipCluster[] = [];
  for (const m of members) {
    const last = clusters[clusters.length - 1];
    if (m.clipped && last) last.clipped.push(m);
    else clusters.push({ base: m, clipped: [] });
  }
  return clusters;
}

/** mask-image 全家桶（蒙版壳与剪贴壳共用；`mode` 决定吃亮度还是吃 alpha）。 */
function maskStyle(url: string, mode: 'luminance' | 'alpha'): React.CSSProperties {
  const image = `url("${url}")`;
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskMode: mode,
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
  };
}

interface LayerRenderOpts {
  /** 按层取调色滤镜 id（只有带调色的层有定义，见 ImageEditor 的 <svg> 滤镜段） */
  filterFor: (layer: EditorLayer) => string | undefined;
  onLayerError: (message: string) => void;
}

/**
 * 图层的像素载体。`mode='full'`（主画布）：位图仓有则渲染内存画布（订阅版本，
 * 笔划/撤销抬手重画），否则 `<img>` 读文件；`mode='mini'`（全览）：迷你画布
 * （miniSources，≤384px）→ 代理 dataUrl → 文件 URL 三级回退。
 * 两种模式的样式/变换/混合完全一致（mini 画布小，CSS 拉伸到自然尺寸）。
 */
const LayerPixels: React.FC<{
  layer: EditorLayer;
  mode: 'full' | 'mini';
  opts: LayerRenderOpts;
  style: React.CSSProperties;
}> = ({ layer, mode, opts, style }) => {
  const key = layerKey(layer.id);
  const version = React.useSyncExternalStore(
    mode === 'mini' ? subscribeMini : subscribeBitmaps,
    () => (mode === 'mini' ? miniVersionOf(key) : bitmapVersion(key)),
  );
  // readBitmap（纯读，不触碰 LRU 时钟）——peekBitmap 在 render 期有写副作用（审计 P2#6）
  const canvas = mode === 'mini' ? peekMini(key) : readBitmap(key);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  // useLayoutEffect：canvas 元素首次挂载时先于浏览器绘制设好背板尺寸并画上像素，
  // 否则第一帧是默认 300×150 的空画布（img → canvas 切换那一瞬会闪，审计 P2#13）
  React.useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c || !canvas) return;
    if (mode === 'mini') {
      // 迷你画布本身就小：贴着源尺寸建背面缓冲，CSS 负责放大到文档空间
      if (c.width !== canvas.width) c.width = canvas.width;
      if (c.height !== canvas.height) c.height = canvas.height;
    } else {
      c.width = layer.naturalWidth;
      c.height = layer.naturalHeight;
    }
    const ctx = c.getContext('2d');
    if (ctx) ctx.drawImage(canvas, 0, 0);
    // 依赖含 version：同一块缓冲对象被笔划/补丁改写时必须重画（对象身份不变）
  }, [canvas, version, layer.naturalWidth, layer.naturalHeight, mode]);

  if (canvas) return <canvas ref={canvasRef} style={style} aria-label={layer.name} />;
  const src =
    mode === 'mini'
      ? miniPixelUrlOf(layer)
      : convertFileSrc(displaySourceOf(key, layer.source as string));
  return (
    <img
      src={src}
      alt={layer.name}
      draggable={false}
      onError={() => opts.onLayerError(`无法打开图层「${layer.name}」`)}
      style={style}
    />
  );
};

/**
 * **画过蒙版**的像素载体（主画布专用，2026-10-25 蒙版显示正确性轮）：
 * 图层位图 ×（蒙版位图 亮度→alpha）合成进一块 canvas，订阅两个位图版本，
 * useLayoutEffect 里同步重画——撤销补丁/抬笔合成与浏览器绘制**同帧原子**，
 * 没有 URL 换图 = 没有解码/重栅格化 = 没有"刷新一下"。
 *
 * 蒙版几何（链接/解链）折进合成矩阵：`paintTargetOf` 给出 doc→缓冲的变换，
 * 蒙版缓冲→图层像素 = doc→图层 ∘ (doc→蒙版)⁻¹——与 Rust `apply_mask` 的
 * warp 同一套数学（brushPaint 有四角重合单测）。挂载条件（两块位图都在内存）
 * 由 LayerElement 保证；层位图缺时它会触发物化并暂时走 CSS 壳回退。
 */
const MaskedPixels: React.FC<{
  layer: EditorLayer;
  style: React.CSSProperties;
}> = ({ layer, style }) => {
  const lKey = layerKey(layer.id);
  const mKey = maskKey(layer.id);
  const layerV = React.useSyncExternalStore(subscribeBitmaps, () => bitmapVersion(lKey));
  const maskV = React.useSyncExternalStore(subscribeBitmaps, () => bitmapVersion(mKey));
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  React.useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const layerBmp = readBitmap(lKey);
    const maskBmp = readBitmap(mKey);
    const layerTarget = paintTargetOf(layer, 'image');
    const maskTarget = paintTargetOf(layer, 'mask');
    if (!layerBmp || !maskBmp || !layerTarget || !maskTarget) return;
    if (c.width !== layerTarget.width) c.width = layerTarget.width;
    if (c.height !== layerTarget.height) c.height = layerTarget.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(layerBmp, 0, 0);
    const docToMask = invertAffine(maskTarget.transform);
    if (!docToMask) return; // 蒙版矩阵退化：零面积 = 全隐藏，清空即是
    ctx.globalCompositeOperation = 'destination-in';
    ctx.filter = `url(#${MASK_LUM_TO_ALPHA_FILTER_ID})`;
    const m = multiplyAffine(layerTarget.transform, docToMask);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(maskBmp, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    // 依赖只钉**几何与像素**（box/mask 对象身份在无关 doc 变更下保持稳定）：
    // 拖不透明度/换选中这类 doc 变更不该触发整层重合成（24MP × 3 趟）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lKey, mKey, layerV, maskV, layer.box, layer.mask, layer.naturalWidth, layer.naturalHeight]);

  return <canvas ref={canvasRef} style={style} aria-label={layer.name} />;
};

/**
 * 画一个图层元素。画过的蒙版（主画布 + 两块位图都在内存）= `MaskedPixels`
 * 单元素直出；其余（无蒙版 / 停用 / 蒙版没画过或被逐出）走 CSS 壳结构
 * （A 蒙版壳 + B 内容壳，或无蒙版时直接像素）。`parent` = 外链（剪贴壳或
 * 恒等）的**画布空间**合成矩阵。
 *
 * 矩阵退化（图层/蒙版被压成线）返回 null：面积已为零，画不画都不可见，
 * Rust 侧同样会在 `DegenerateAffine` 上失败——两端一致的"消失"。
 */
const LayerElement: React.FC<{
  layer: EditorLayer;
  parent: AffineMatrix;
  opts: LayerRenderOpts;
  mode: 'full' | 'mini';
}> = ({ layer, parent, opts, mode }) => {
  // ⚠️ hooks 必须在下面的 early-return **之前**：同一层"无蒙版 → 有蒙版"
  // （或反向/停用）时结构会变，条件调用 hook 直接崩（审计 P0#1）。
  const lKey = layerKey(layer.id);
  const mKey = maskKey(layer.id);
  const maskV = React.useSyncExternalStore(subscribeBitmaps, () => bitmapVersion(mKey));
  const maskActive = !!layer.mask && !layer.mask.disabled;
  const maskBmp = readBitmap(mKey);
  // 画过的蒙版（位图在内存）→ 主画布走合成画布；图层位图也得在（没有它合成
  // 不出来）——缺就触发物化，就绪（版本+1）后自动切过去
  const useCanvasMask = mode === 'full' && maskActive && !!maskBmp && !!readBitmap(lKey);
  React.useEffect(() => {
    if (mode !== 'full' || !maskActive || !maskBmp || readBitmap(lKey) || !layer.source) return;
    materializeBitmap(lKey, {
      sourcePath: layer.source as string,
      width: layer.naturalWidth,
      height: layer.naturalHeight,
    }).catch(() => undefined); // 失败不打扰：CSS 壳路径还能顶（烘焙文件在的话）
    // maskV 进依赖：蒙版位图"出现"（新建/撤销恢复/逐出后重物化）时要重查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, maskActive, maskBmp, maskV, lKey, layer.source, layer.naturalWidth, layer.naturalHeight]);

  const mLayer = composeMatrix(layer.box, {
    width: layer.naturalWidth,
    height: layer.naturalHeight,
  });
  const parentInv = invertAffine(parent);
  if (!parentInv) return null;
  const localOf = (m: AffineMatrix): AffineMatrix => multiplyAffine(parentInv, m);
  const filter = opts.filterFor(layer);
  const blend = layerBlend(layer);
  const opacity = layer.visible ? layerOpacity(layer) / 100 : 0;
  const pixelsStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: layer.naturalWidth,
    height: layer.naturalHeight,
    /**
     * **必须关掉浏览器的 EXIF 自动转正**：图层方向已经由 `orientationToBox`
     * 折进 rotation/flip 了；让浏览器再转一次就是"转两遍"，且 Rust 导出只按
     * 我们的变换算——屏幕和导出对不上（S8 的核心那一行）。
     */
    imageOrientation: 'none',
    // Tailwind preflight 给所有 img 设了 max-width:100%，必须顶回去
    maxWidth: 'none',
    maxHeight: 'none',
  };
  const directStyle: React.CSSProperties = {
    ...pixelsStyle,
    transformOrigin: '0 0',
    transform: toCssMatrix(localOf(mLayer)),
    filter,
    mixBlendMode: blend,
    opacity,
  };

  // 画过的蒙版：合成画布单元素直出（矩阵/滤镜/混合挂法与无蒙版直出相同）
  if (useCanvasMask) {
    return <MaskedPixels layer={layer} style={directStyle} />;
  }

  // 无蒙版 / 蒙版停用 / 画过但图层位图还没物化好：内容直出或 CSS 壳。
  // ⚠️ CSS 壳只认 URL：蒙版位图在内存但**还没烘焙**（第一次画/新建空白蒙版）
  // 时没有任何可用文件——硬读 source 只会 404（CSS 对加载失败的 mask 按全
  // 隐藏处理，整层会消失）。这个窗口按"无蒙版"渲染，位图/烘焙就绪即切正确
  // 路径；烘焙文件在（画过且烤过，图层位图被逐出的情形）则照常走壳。
  const maskHasFile = !maskBmp || !!bitmapMeta(mKey)?.bakedPath;
  const shell = maskActive && maskHasFile ? maskShellSpec(layer) : null;
  if (!shell) {
    return <LayerPixels layer={layer} mode={mode} opts={opts} style={directStyle} />;
  }

  // 有蒙版：A 壳（蒙版空间）> B 壳（内容）> 像素。壳几何见 maskShellSpec：
  // 链接 = 图层内容框（蒙版拉伸铺满，退化为第一轮的"mask 直接挂 img"），
  // 解链 = 蒙版自己的内容框。
  const maskInv = invertAffine(shell.matrix);
  if (!maskInv) return null; // 蒙版框被压扁：蒙版没有可表达的面积

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: shell.width,
        height: shell.height,
        transformOrigin: '0 0',
        transform: toCssMatrix(localOf(shell.matrix)),
        // **`mask-mode: luminance` 必须显式给**：缺省 match-source（图片 = 用 alpha），
        // 一张不透明的黑白 PNG 会变成"全显示"，与 Rust 的"亮度 × alpha"口径不一致。
        // 剩余与 Rust 的已知差异：EXIF 方向——CSS 自动转正带方向的 JPEG 蒙版而 Rust
        // 不转；蒙版预期形态是灰度 PNG，记录在进度文档，不为此上预处理。
        ...maskStyle(
          convertFileSrc(displaySourceOf(mKey, (layer.mask?.source as string) ?? '')),
          'luminance',
        ),
        filter,
        mixBlendMode: blend,
        opacity,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          // B 壳挂在 A 里：外链是蒙版壳矩阵（P 在链上抵消），内容 = inv(M_mask)·M_layer。
          // 链接时 M_mask = M_layer，B 退化为恒等。
          transform: toCssMatrix(multiplyAffine(maskInv, mLayer)),
        }}
      >
        <LayerPixels layer={layer} mode={mode} opts={opts} style={pixelsStyle} />
      </div>
    </div>
  );
};

/**
 * 渲染一串成员（平层 flush 或组内成员）：分剪贴簇，基础层直出，
 * 剪贴层套 C 壳（基础层图做 **alpha** 蒙版——剪贴吃的是基础层 alpha，
 * 与图层蒙版的黑白语义无关）。
 */
function clusterElements(
  members: EditorLayer[],
  opts: LayerRenderOpts,
  mode: 'full' | 'mini',
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (const { base, clipped } of clipClusters(members)) {
    out.push(<LayerElement key={base.id} layer={base} parent={IDENTITY} opts={opts} mode={mode} />);
    if (clipped.length === 0) continue;
    const mBase = composeMatrix(base.box, {
      width: base.naturalWidth,
      height: base.naturalHeight,
    });
    // 基础层被压扁 → 剪贴没有可依附的面积，剪贴层退化为直出（与 Rust 同口径）
    if (!invertAffine(mBase)) {
      out.push(...clipped.map(c => (
        <LayerElement key={c.id} layer={c} parent={IDENTITY} opts={opts} mode={mode} />
      )));
      continue;
    }
    out.push(
      <div
        key={`${base.id}-clip`}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: base.naturalWidth,
          height: base.naturalHeight,
          transformOrigin: '0 0',
          transform: toCssMatrix(mBase),
          // 不另设 isolation：壳因 transform 已自成 stacking context（非 normal
          // 混合的剪贴层预览近似，见文件头"已知取舍"）
          ...maskStyle(
            convertFileSrc(displaySourceOf(layerKey(base.id), base.source as string)),
            'alpha',
          ),
        }}
      >
        {clipped.map(c => (
          <LayerElement key={c.id} layer={c} parent={mBase} opts={opts} mode={mode} />
        ))}
      </div>,
    );
  }
  return out;
}

export const EditorCanvasLayers: React.FC<{
  tabId: string;
  canvas: EditorCanvas;
  transform: { x: number; y: number; scale: number };
  layers: EditorLayer[];
  onLayerError: (message: string) => void;
  /** `'mini'` = 全览图的迷你渲染（像素源换 miniSources，无阴影装饰） */
  mode?: 'full' | 'mini';
}> = ({ tabId, canvas, transform, layers, onLayerError, mode = 'full' }) => {
  const opts: LayerRenderOpts = {
    // 每层各引用自己的调色滤镜 id（只有带调色的层有定义，见 ImageEditor 的 <svg> 段）
    filterFor: layer =>
      isZeroAdjustments(layer.adjust)
        ? undefined
        : `aurora-editor-layer-${tabId}-${layer.id}`,
    onLayerError,
  };

  // 透明用棋盘格——PS 的通用表达，用户一眼知道"这里没东西"。
  //
  // ⚠️ 格子必须是**屏幕空间固定大小**：这个 div 带着 `scale(transform.scale)`，
  // 如果 background-size 写死 16px，缩小到 25% 时一个格子只剩 4 个屏幕像素，
  // 密到糊成一片灰（用户实测："看起来像一块灰色的密密麻麻的东西"）。
  // 所以按缩放**反向补偿**，让格子永远 16 个屏幕像素。
  const checkerScale = transform.scale > 0 ? transform.scale : 1;
  const checkerSize = `${16 / checkerScale}px ${16 / checkerScale}px`;
  const isTransparentBg = !canvas.background || canvas.background === 'transparent';

  // 分段 → 渲染单元：连续的 flat 段合并成一个 flush（**剪贴簇不跨组**，
  // 但相邻平层之间允许），组段渲染成组 div（组成员内部再分簇）。
  // 可见性在这层剪（Rust 的合成分不清可见性，§6 第 11 条）。
  const units: React.ReactNode[] = [];
  let flatBuffer: EditorLayer[] = [];
  const flushFlats = () => {
    if (flatBuffer.length === 0) return;
    const visible = flatBuffer.filter(m => m.source && m.visible);
    if (visible.length > 0) units.push(...clusterElements(visible, opts, mode));
    flatBuffer = [];
  };
  for (const seg of splitSegments(layers)) {
    if (seg.type === 'flat') {
      flatBuffer.push(seg.layer);
    } else {
      flushFlats();
      // 组行被眼睛关掉 = 整组隐藏（PS 同款）
      if (seg.row.visible === false) continue;
      units.push(
        <div
          key={seg.row.id}
          className="absolute inset-0"
          style={{
            mixBlendMode: layerBlend(seg.row),
            opacity: layerOpacity(seg.row) / 100,
            isolation: 'isolate',
          }}
        >
          {clusterElements(
            seg.members.filter(m => m.source && m.visible),
            opts,
            mode,
          )}
        </div>,
      );
    }
  }
  flushFlats();

  return (
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
        backgroundColor: '#ffffff',
        backgroundImage: isTransparentBg
          ? 'repeating-conic-gradient(#d0d0d0 0% 25%, #ffffff 0% 50%)'
          : undefined,
        backgroundSize: isTransparentBg ? checkerSize : undefined,
        boxShadow: mode === 'full' ? '0 0 0 1px rgba(0,0,0,0.15)' : undefined,
      }}
    >
      <div className="absolute inset-0" style={{ isolation: 'isolate' }}>
        {!isTransparentBg && (
          <div
            className="absolute inset-0"
            style={{
              backgroundColor: canvas.background === 'black' ? '#000000' : '#ffffff',
            }}
          />
        )}
        {/* 自底向上按**分段 + 剪贴簇**渲染：分段与导出 payload 同一份
            （splitSegments），剪贴簇的归并口径与 layerClipping / Rust 一致。 */}
        {units}
      </div>
    </div>
  );
};
