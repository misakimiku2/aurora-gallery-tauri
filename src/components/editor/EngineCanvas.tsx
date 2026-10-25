/**
 * 引擎显示画布（管线换血 M3，设计稿 §7）——`EditorCanvasLayers` 的替换者。
 *
 * ## 结构（从外到内）
 *
 * ```
 * <div 画布容器：文档尺寸 + 视口 transform + 棋盘格/底色>
 *   <img settle 基底帧>     ← 文档分辨率整帧（A 档，磁盘旁路），CSS 缩放
 *   <canvas 视口细节帧>     ← 可视区域实时帧（B 档），putImageData 命令式更新
 * </div>
 * ```
 *
 * - **settle 帧就是"静置真相"**：文档分辨率 → 任何缩放级别看到的都是真像素
 *   （不变量 §2"放大到 100% 看到真像素"由帧的分辨率保证，与 DOM 时代同一语义）；
 * - **视口帧盖在 settle 上面**：两帧由同一条合成代码产出（parity 逐位一致），
 *   新帧到达即无缝覆盖；区域外露出的 settle 帧最多滞后一个防抖周期；
 * - 白/黑底**画进引擎合成**（参与混合——§6.19① 的坑在新家的等价物）；透明底的
 *   棋盘格留在容器 CSS 上（帧是 alpha 的，格子透出来）。
 *
 * 选择框/变换柄/裁剪框/画笔光标等 chrome 不在这里——它们照旧盖在 ImageEditor
 * 的容器里（引擎显示只换"像素"，不换"交互"）。
 */
import React from 'react';
import type { EditorCanvas, EditorLayer } from '../../types';
import { useEngineDisplay } from './engineDisplay';

export const EngineCanvas: React.FC<{
  tabId: string;
  canvas: EditorCanvas;
  layers: EditorLayer[];
  transform: { x: number; y: number; scale: number };
}> = ({ tabId, canvas, layers, transform }) => {
  const { settleUrl, viewport, viewportRef } = useEngineDisplay(
    tabId,
    canvas,
    layers,
    transform,
  );

  // 棋盘格 = 屏幕空间固定 16px（按缩放反向补偿，缩小才不会糊成灰——§6 的老坑）
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
      {settleUrl && (
        <img
          src={settleUrl}
          alt="文档合成"
          draggable={false}
          /**
           * EXIF 方向已折进图层变换（orientationToBox），必须关掉浏览器的
           * 自动转正——与 DOM 时代的图层 img 同一条铁律（§6 第 5 条）。
           */
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: canvas.width,
            height: canvas.height,
            imageOrientation: 'none',
            maxWidth: 'none',
            maxHeight: 'none',
            pointerEvents: 'none',
          }}
        />
      )}
      <canvas
        ref={viewportRef}
        aria-label="引擎视口帧"
        style={{
          position: 'absolute',
          left: viewport?.left ?? 0,
          top: viewport?.top ?? 0,
          width: viewport?.width ?? 0,
          height: viewport?.height ?? 0,
          pointerEvents: 'none',
          // 首帧前不占位不闪（canvas 默认 300×150 透明，视觉上等于不存在）
          display: viewport ? 'block' : 'none',
        }}
      />
    </div>
  );
};
