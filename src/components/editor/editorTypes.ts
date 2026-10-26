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
  children?: EditorLayer[];
  expanded?: boolean;
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
