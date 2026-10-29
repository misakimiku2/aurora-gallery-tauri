/** photocraft 引擎状态自省(document.inspect + 会话级颜色)的前端类型。 */

export interface EditorLayer {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  fill: number;
  blend: string;
  clipped: boolean;
  hasMask: boolean;
  bounds: [number, number, number, number] | null;
  selected: boolean;
  /** 图层颜色标记(inspect labelColor;none/red/.../gray,PS 行染色口径)。 */
  labelColor?: string;
  /** 链接组 id(inspect linkGroup;同组图层随移动工具一起动,引擎 with_links 口径)。 */
  linkGroup?: number | null;
  children?: EditorLayer[];
  expanded?: boolean;
  /** 调整层(inspect 附加字段):kind 与 layer.setAdjustment/newAdjustmentLayer 同口径。 */
  adjustment?: {
    kind: string;
    params: Record<string, unknown>;
    unsupported?: boolean;
    psdKey?: string;
  };
}

export interface EditorDocState {
  name: string;
  path: string | null;
  width: number;
  height: number;
  mode: string;
  depth: number;
  resolution: number;
  activeLayer: number | null;
  selectedLayers: number[];
  hasSelection: boolean;
  selectionBounds: [number, number, number, number] | null;
  layers: EditorLayer[];
  history: string[];
  /** 当前状态在 history 里的下标(引擎 History::past_len)。 */
  historyCurrent: number;
  canUndo: boolean;
  canRedo: boolean;
  revision: number;
  foreground: number[];
  background: number[];
  /** 图层混合模式显示标签(引擎 LAYER_MODES)。 */
  blendModes?: string[];
  /** 有未保存修改(revision 超过已存水位);文件信息栏状态点 橙=未存 / 绿=已存。 */
  dirty?: boolean;
  /** 通道视图状态(编辑目标等,不入历史):target.kind = composite|layerMask|vectorMask|color|alpha。 */
  channels?: {
    target?: { kind: string; index?: number };
  };
  /** 图层蒙版灰度查看(view.layerMask,Alt+点蒙版缩略图):null=正常合成视图。 */
  layerMaskView?: { layer: number; mode: 'gray' | 'overlay' } | null;
  /** 带像素蒙版图层的蒙版态(桥层补充,inspect 只有 hasMask 布尔):layerId → 蒙版态(密度 0..1/羽化 px 供属性面板回显)。 */
  maskInfo?: Record<string, { enabled: boolean; linked: boolean; density?: number; feather?: number }>;
  /** 图层锁定态(桥层补充;移动工具 Auto-Select 按下探测:锁定层/背景命中=拖出层选框)。 */
  lockInfo?: Record<string, { position: boolean; all: boolean; background: boolean }>;
  /** 是否有浮动选区(select.float 进行中;移动工具 Alt+方向键的复制微移分支要用)。 */
  floating?: boolean;
}

export interface EditorOpenInfo {
  docId: number;
  path: string;
  width: number;
  height: number;
  name: string;
}

export interface RunOutcome {
  revision: number;
  viewRevision: number;
  damage: [number, number, number, number] | null;
  result: unknown;
}

/** 一期工具集;二期加钢笔/文字/形状/路径选择。 */
export type EditorTool =
  | 'move'
  | 'marquee'
  | 'lasso'
  | 'polygonLasso'
  | 'magneticLasso'
  | 'crop'
  | 'eyedropper'
  | 'brush'
  | 'eraser'
  | 'gradient'
  | 'bucket'
  | 'blur'
  | 'sharpen'
  | 'smudge'
  | 'hand'
  | 'zoom';
