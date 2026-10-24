/**
 * 全览图的迷你文档（2026-10-26 架构轮）：直接渲染一份缩小版的
 * `EditorCanvasLayers`（`mode='mini'`）。
 *
 * ## 为什么不再走 Rust 合成
 *
 * 旧全览 = 防抖 → `flushPaintBakes`（排烘焙队列）→ `editor_render_document`
 * （Rust 读盘全量解码合成）→ JPEG → base64 → 前端再降采样——秒级延迟，画一笔
 * 等几秒（用户实测）。现在全览与主画布**共用同一份 DOM 合成代码**（分段/剪贴簇/
 * 蒙版壳/混合/isolation 全部同源），像素源换成迷你画布（画过的层，`miniSources`
 * 防抖 ~150ms 重生成）或代理图（没画过的层）——所见即所得，更新百毫秒级。
 *
 * 调色滤镜直接引用主画布 `<svg>` 里的同一批 id（跨子树引用同一 document 内的
 * 资源；面板行缩略图早就这么干，先例已验证）。
 */
import React, { useEffect, useMemo } from 'react';
import type { EditorCanvas, EditorLayer } from '../../types';
import { EditorCanvasLayers } from './EditorCanvasLayers';
import { bitmapVersion, layerKey } from './layerBitmaps';
import { watchMiniKeys } from './miniSources';
import { ensureLayerPreview } from './layerProxy';

export const EditorMiniDocument: React.FC<{
  tabId: string;
  canvas: EditorCanvas;
  layers: EditorLayer[];
  /** 显示区尺寸（CSS px）——按文档比例缩放塞进去 */
  boxWidth: number;
  boxHeight: number;
}> = ({ tabId, canvas, layers, boxWidth, boxHeight }) => {
  // 关注所有图层键：miniSources 只给挂载中的迷你文档重生成迷你画布
  const keys = useMemo(() => (layers ?? []).map(l => layerKey(l.id)), [layers]);
  useEffect(() => {
    watchMiniKeys(keys, true);
    return () => watchMiniKeys(keys, false);
  }, [keys]);

  // 没画过的层要代理图（迷你平面优先用代理 dataUrl，画质比硬拉原图好）；
  // 幂等 + 排队（MAX_CONCURRENT=2）。**画过的层跳过**——它用迷你画布，跑一趟
  // Rust 全图解码纯属浪费，还会生成缺笔迹的过期代理（审计 P2#10）。
  useEffect(() => {
    for (const l of layers ?? []) {
      if (l.source && bitmapVersion(layerKey(l.id)) === 0) ensureLayerPreview(l);
    }
  }, [layers]);

  if (boxWidth <= 0 || boxHeight <= 0 || canvas.width <= 0 || canvas.height <= 0) return null;
  const scale = Math.min(boxWidth / canvas.width, boxHeight / canvas.height);

  return (
    <div
      className="absolute overflow-hidden"
      style={{
        width: canvas.width * scale,
        height: canvas.height * scale,
      }}
    >
      <EditorCanvasLayers
        tabId={tabId}
        canvas={canvas}
        transform={{ x: 0, y: 0, scale }}
        layers={layers}
        onLayerError={() => {
          /* 全览是辅助面板：单层读不出来不弹错误条（主画布会报） */
        }}
        mode="mini"
      />
    </div>
  );
};
