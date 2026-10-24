/**
 * 画布渲染：画布容器（overflow:hidden 负责裁切）+ 混合组 + 图层元素列表。
 *
 * 从 ImageEditor 搬出（2026-10-24 防膨胀批次 E，见进度文档 §7）——它只消费
 * canvas/transform/layers，不改任何文档状态。
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
 *   A 蒙版壳（仅有蒙版的层）：transform = M_mask，mask-image = 蒙版图（luminance 模式），
 *     尺寸/矩阵由 maskShellSpec 给出（链接 = 图层内容框、蒙版拉伸；解链 = 蒙版自己的框）
 *     B 内容壳：transform = inv(M_mask)·M_layer（外链在外层壳上抵消，见下）
 *       <img> 图层像素，1:1 自然尺寸、无变换
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

/** 剪贴簇：一个基础层 + 接在它上面的连续剪贴层（PS 的 Clipping Mask 语义）。 */
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
 * 画一个图层元素（蒙版壳 A + 内容壳 B，或无蒙版时直接 img）。
 * `parent` = 外链（剪贴壳或恒等）的**画布空间**合成矩阵。
 *
 * 矩阵退化（图层/蒙版被压成线）返回 null：面积已为零，画不画都不可见，
 * Rust 侧同样会在 `DegenerateAffine` 上失败——两端一致的"消失"。
 */
function layerElement(
  layer: EditorLayer,
  parent: AffineMatrix,
  opts: LayerRenderOpts,
): React.ReactNode {
  const mLayer = composeMatrix(layer.box, {
    width: layer.naturalWidth,
    height: layer.naturalHeight,
  });
  const parentInv = invertAffine(parent);
  if (!parentInv) return null;
  const localOf = (m: AffineMatrix): AffineMatrix => multiplyAffine(parentInv, m);
  const filter = opts.filterFor(layer);
  const onLayerError = opts.onLayerError;
  const blend = layerBlend(layer);
  const opacity = layer.visible ? layerOpacity(layer) / 100 : 0;
  const commonImg = {
    src: convertFileSrc(layer.source as string),
    alt: layer.name,
    draggable: false,
    onError: () => onLayerError(`无法打开图层「${layer.name}」`),
  } as const;

  // 无蒙版（或蒙版被停用——Shift+点缩略图，合成按无蒙版走，见 maskShellSpec）：
  // 内容直出（第一轮的结构），transform 折算进外链坐标系
  const shell = maskShellSpec(layer);
  if (!shell) {
    return (
      <img
        key={layer.id}
        {...commonImg}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: layer.naturalWidth,
          height: layer.naturalHeight,
          transformOrigin: '0 0',
          transform: toCssMatrix(localOf(mLayer)),
          filter,
          mixBlendMode: blend,
          opacity,
          /**
           * **必须关掉浏览器的 EXIF 自动转正**：图层方向已经由 `orientationToBox`
           * 折进 rotation/flip 了；让浏览器再转一次就是"转两遍"，且 Rust 导出只按
           * 我们的变换算——屏幕和导出对不上（S8 的核心那一行）。
           */
          imageOrientation: 'none',
          // Tailwind preflight 给所有 img 设了 max-width:100%，必须顶回去
          maxWidth: 'none',
          maxHeight: 'none',
        }}
      />
    );
  }

  // 有蒙版：A 壳（蒙版空间）> B 壳（内容）> img。壳几何见 maskShellSpec：
  // 链接 = 图层内容框（蒙版拉伸铺满，退化为第一轮的"mask 直接挂 img"），
  // 解链 = 蒙版自己的内容框。
  const maskInv = invertAffine(shell.matrix);
  if (!maskInv) return null; // 蒙版框被压扁：蒙版没有可表达的面积
  // 走到这里 mask 一定存在（maskShellSpec 对无蒙版/停用返回 null，上面已分流）
  const mask = layer.mask as NonNullable<EditorLayer['mask']>;

  return (
    <div
      key={layer.id}
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
        ...maskStyle(convertFileSrc(mask.source), 'luminance'),
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
        <img
          {...commonImg}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: layer.naturalWidth,
            height: layer.naturalHeight,
            imageOrientation: 'none',
            maxWidth: 'none',
            maxHeight: 'none',
          }}
        />
      </div>
    </div>
  );
}

/**
 * 渲染一串成员（平层 flush 或组内成员）：分剪贴簇，基础层直出，
 * 剪贴层套 C 壳（基础层图做 **alpha** 蒙版——剪贴吃的是基础层 alpha，
 * 与图层蒙版的黑白语义无关）。
 */
function clusterElements(members: EditorLayer[], opts: LayerRenderOpts): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (const { base, clipped } of clipClusters(members)) {
    out.push(layerElement(base, IDENTITY, opts));
    if (clipped.length === 0) continue;
    const mBase = composeMatrix(base.box, {
      width: base.naturalWidth,
      height: base.naturalHeight,
    });
    // 基础层被压扁 → 剪贴没有可依附的面积，剪贴层退化为直出（与 Rust 同口径）
    if (!invertAffine(mBase)) {
      out.push(...clipped.map(c => layerElement(c, IDENTITY, opts)));
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
          ...maskStyle(convertFileSrc(base.source as string), 'alpha'),
        }}
      >
        {clipped.map(c => layerElement(c, mBase, opts))}
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
}> = ({ tabId, canvas, transform, layers, onLayerError }) => {
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
    if (visible.length > 0) units.push(...clusterElements(visible, opts));
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
        boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
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
