/**
 * 画布渲染：画布容器（overflow:hidden 负责裁切）+ 混合组 + 图层 `<img>` 列表。
 *
 * 从 ImageEditor 搬出（2026-10-24 防膨胀批次 E，见进度文档 §7）——它只消费
 * canvas/transform/layers，不改任何文档状态。
 *
 * 图层混合组：`isolation: isolate` 把 `mix-blend-mode` 的作用范围锁在组内——
 * 否则最底下那层会跟画布外的棋盘格/应用背景混在一起。白/黑底**画在组内**
 * （它参与混合，与 Rust 先铺背景再叠层的顺序一致）；透明底的棋盘格留在组外——
 * 它只是"这里没东西"的装饰，不该被混。
 */
import React, { useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { EditorCanvas, EditorLayer } from '../../types';
import { composeMatrix, toCssMatrix } from './layerTransform';
import { buildAdjustMatrix, isZeroAdjustments } from './colorMatrix';
import { layerBlend, layerOpacity } from './layerModel';

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

export const EditorCanvasLayers: React.FC<{
  tabId: string;
  canvas: EditorCanvas;
  transform: { x: number; y: number; scale: number };
  layers: EditorLayer[];
  onLayerError: (message: string) => void;
}> = ({ tabId, canvas, transform, layers, onLayerError }) => {
  const layerFilterId = (layerId: string) => `aurora-editor-layer-${tabId}-${layerId}`;

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
        // 所以这一行同时就是"导出会怎么混"的承诺（画布容器已 isolation）
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
  const isTransparentBg = !canvas.background || canvas.background === 'transparent';

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
        {/* 自底向上按**分段**渲染：组成员包进组 div（组的 opacity/blend/visible 作用
            整组，组内成员的互相合成走浏览器原生嵌套语义，与 Rust 的分段合成一致）。
            分段算法与导出 payload 同一份（见 `splitSegments`）。 */}
        {splitSegments(layers).map(seg =>
          seg.type === 'group' ? (
            /* 组行被眼睛关掉 = 整组隐藏（PS 同款） */
            seg.row.visible === false ? null : (
              <div
                key={seg.row.id}
                className="absolute inset-0"
                style={{
                  mixBlendMode: layerBlend(seg.row),
                  opacity: layerOpacity(seg.row) / 100,
                  isolation: 'isolate',
                }}
              >
                {seg.members.map(m =>
                  m.source ? (
                    <img
                      key={m.id}
                      src={convertFileSrc(m.source)}
                      alt={m.name}
                      draggable={false}
                      style={buildLayerStyle(m)}
                      onError={() => onLayerError(`无法打开图层「${m.name}」`)}
                    />
                  ) : null,
                )}
              </div>
            )
          ) : seg.layer.source ? (
            <img
              key={seg.layer.id}
              src={convertFileSrc(seg.layer.source)}
              alt={seg.layer.name}
              draggable={false}
              style={buildLayerStyle(seg.layer)}
              onError={() => onLayerError(`无法打开图层「${seg.layer.name}」`)}
            />
          ) : null,
        )}
      </div>
    </div>
  );
};
