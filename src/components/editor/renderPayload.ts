/**
 * 图层 → Rust 合成请求的**共用载荷构造**。
 *
 * `editor_export_document`（导出）与 `editor_render_document`（全览图）收的是同一个
 * `DocumentRequest` 形状（画布 + 分段）。2026-10-24 编组落地后导出侧换成了 `groups`
 * 分段，而图层面板的全览图还在发旧的 `layers` 平铺形状——Rust 侧 `DocumentRequest`
 * 根本没有那个字段，全览图从此**静默失效**（错误被 catch 吞掉，表现为面板一直显示
 * 占位图）。这层抽出来就是要让两端**只存在一份**构造逻辑：导出与全览再也不会各改
 * 各的然后漂移。
 *
 * 蒙版（2026-10-24）：每层可带 `mask`（源文件路径），语义 = 蒙版亮度 × alpha 乘进
 * 图层 alpha（详见 `imaging/mask.rs` / CSS `mask-image` 两条同构实现）。
 */
import type { EditorLayer } from '../../types';
import { splitSegments } from './EditorCanvasLayers';
import { layerBlend, layerOpacity } from './layerModel';
import { composeMatrix } from './layerTransform';

export interface RenderLayerPayload {
  path: string;
  /** CSS 顺序的仿射六参（`composeMatrix` 的产物，两端共用同一组数） */
  matrix: number[];
  /** 调色；null = 不动 */
  adjust: EditorLayer['adjust'] | null;
  /** 不透明度百分比（0..=100） */
  opacity: number;
  /** 混合模式（kebab-case，与 CSS `mix-blend-mode` 同名） */
  blend: string;
  /**
   * 图层蒙版。null = 无（或**已停用**——停用只是不参与合成，数据在前端保留）；
   * `matrix: null` = **链接**（蒙版拉伸铺满图层内容，Rust 走预乘路径）；
   * 有矩阵 = **解链**（蒙版自己的画布空间矩阵，Rust 把蒙版换算到图层内容空间后
   * 仍走同一条乘 alpha 路径，与 CSS 包裹渲染数学同构）。
   */
  mask: { path: string; matrix: number[] | null } | null;
  /** 剪贴蒙版：只显示在同分段内下方基础层有像素处（吃基础层 alpha） */
  clipped: boolean;
}

export interface RenderGroupPayload {
  opacity: number;
  blend: string;
  layers: RenderLayerPayload[];
}

/**
 * 把（自底向上的）图层数组变成 Rust 的**分段**载荷：平层 = 单成员组，组 = 成员段 +
 * 组行。组行被眼睛关掉 = 整组不进载荷（Rust 的合成分不清"可见性"，§6 第 11 条）。
 */
export function buildRenderGroups(layers: EditorLayer[]): RenderGroupPayload[] {
  return splitSegments(layers)
    // 组行被眼睛关掉 = 整组不进载荷（CSS 渲染侧 `seg.row.visible === false` 走 null；
    // 导出与全览在这边剪——旧的内联导出漏了这一判，组行隐藏后成员照常进导出，
    // 屏幕上没有、成品里又有）
    .filter(seg => (seg.type === 'group' ? seg.row : seg.layer).visible !== false)
    .map(seg => {
      const row = seg.type === 'group' ? seg.row : seg.layer;
      const members = seg.type === 'group' ? seg.members : [seg.layer];
      return {
        opacity: layerOpacity(row),
        blend: layerBlend(row),
        layers: members
          .filter(m => m.source && m.visible)
          .map(m => ({
            path: m.source as string,
            matrix: composeMatrix(m.box, {
              width: m.naturalWidth,
              height: m.naturalHeight,
            }),
            adjust: m.adjust ?? null,
            opacity: layerOpacity(m),
            blend: layerBlend(m),
            // 停用的蒙版按无蒙版发（PS 的 Shift+点缩略图：临时不参与合成，数据在前端保留）
            mask:
              m.mask && !m.mask.disabled
                ? {
                    path: m.mask.source,
                    matrix: m.mask.box
                      ? composeMatrix(m.mask.box, {
                          width: m.mask.naturalWidth,
                          height: m.mask.naturalHeight,
                        })
                      : null,
                  }
                : null,
            clipped: m.clipped === true,
          })),
      };
    })
    .filter(g => g.layers.length > 0);
}
