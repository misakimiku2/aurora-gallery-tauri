/**
 * 路径面板纯逻辑(二期 二-4,上游 vector_ui.rs paths_panel 段逐行移植):
 * path_rows 行序/free_path_name/复制名/active_path_name/右键菜单动作表。
 * 引擎命令参数口径(vector_cmds.rs):path.list 返回摘要(knots 计数,完整几何在
 * path.info);path.set/rename/delete 的 name="work"=工作路径,"layer"=活动层路径。
 */

/** path.list 的返回摘要(paths_list;layerPath=活动层的形状路径/矢量蒙版)。 */
export interface PathListSummary {
  paths: { name: string; knots: number; subpaths: number }[];
  workPath: { knots: number; subpaths: number } | null;
  layerPath: { kind: 'shape' | 'vectorMask'; layer: number; name: string; knots: number } | null;
}

/** 路径面板行的种类(上游 PathRow):Saved=已存路径,Work=工作路径,
 * Layer=活动层的形状路径或矢量蒙版(临时,斜体)。 */
export type PathRowKind = 'saved' | 'work' | 'layer';

export interface PathRow {
  /** 命令寻址键:"work" / "layer" / 已存路径名(上游 key)。 */
  key: string;
  /** 显示名(工作路径中文标签;层行=「<层名> 形状路径/矢量蒙版」)。 */
  name: string;
  kind: PathRowKind;
  knots: number;
  subpaths: number;
  /** 可拖到垃圾桶删除(上游:层形状路径不可拖)。 */
  deletable: boolean;
}

/** 面板行,自上而下(上游 path_rows):已存路径 → 工作路径 → 活动层路径,同 PS。 */
export function pathRows(list: PathListSummary | null | undefined): PathRow[] {
  if (!list) return [];
  const rows: PathRow[] = list.paths.map((p) => ({
    key: p.name, name: p.name, kind: 'saved' as const, knots: p.knots, subpaths: p.subpaths, deletable: true,
  }));
  if (list.workPath) {
    rows.push({ key: 'work', name: '工作路径', kind: 'work', knots: list.workPath.knots, subpaths: list.workPath.subpaths, deletable: true });
  }
  if (list.layerPath) {
    // 引擎层行名是英文「<层名> Shape Path/Vector Mask」;显示中文(面板全中文口径)
    const layerName = list.layerPath.name.replace(/ (Shape Path|Vector Mask)$/, '');
    rows.push({
      key: 'layer',
      name: list.layerPath.kind === 'shape' ? `${layerName} 形状路径` : `${layerName} 矢量蒙版`,
      kind: 'layer',
      knots: list.layerPath.knots,
      subpaths: 0,
      deletable: list.layerPath.kind === 'vectorMask',
    });
  }
  return rows;
}

/** 面板当前目标(上游 paths_panel 的 sel):选中键有效(层行须仍在)否则回落工作路径。 */
export function panelTargetPath(rows: PathRow[], selected: string | null | undefined): string {
  if (selected && (selected !== 'layer' || rows.some((r) => r.kind === 'layer'))) return selected;
  return 'work';
}

/** 无名命令作用路径(上游 active_path_name):面板选中(在行里才有效)→ 工作路径 → 活动层路径。 */
export function activePathName(rows: PathRow[], selected: string | null | undefined): string | null {
  const valid = selected != null && rows.some((r) => r.key === selected);
  if (valid) return selected;
  const work = rows.find((r) => r.kind === 'work');
  if (work) return work.key;
  const layer = rows.find((r) => r.kind === 'layer');
  return layer ? layer.key : null;
}

/** 已存路径的默认名(上游 free_path_name):首个空闲「Path N」,N 从已存数+1 起。 */
export function freePathName(existing: string[]): string {
  let n = existing.length + 1;
  while (existing.includes(`Path ${n}`)) {
    n += 1;
    if (n === Number.MAX_SAFE_INTEGER) break;
  }
  return `Path ${n}`;
}

/** 复制路径名(上游 Duplicate Path):首个空闲「<名> copy N」。 */
export function copyPathName(name: string, existing: string[]): string {
  let n = 1;
  while (existing.includes(`${name} copy ${n}`)) {
    n += 1;
    if (n === Number.MAX_SAFE_INTEGER) break;
  }
  return `${name} copy ${n}`;
}

/** 行右键菜单动作(上游 path_context_actions;顺序同上游)。拦截类动作由面板处理:
 * selection=建立选区对话框 / stroke=描边路径对话框 / rename=行内重命名。 */
export type PathMenuAction =
  | { kind: 'selection'; label: string; disabled?: boolean }
  | { kind: 'fill'; label: string; disabled?: boolean }
  | { kind: 'stroke'; label: string; disabled?: boolean }
  | { kind: 'cmd'; label: string; cmd: string; params: Record<string, unknown> }
  | { kind: 'rename'; label: string }
  | { kind: 'delete'; label: string; cmd: string; params: Record<string, unknown> };

export function pathContextActions(
  row: PathRow,
  existingNames: string[],
  /** 该行完整几何(Duplicate Path 的 path 参数;暂缺=null 则不提供复制)。 */
  rowPathJson: unknown | null,
  /** 活动层可画(像素层)——fill/stroke 才可用(上游 can_paint 门)。 */
  canPaint: boolean,
): PathMenuAction[] {
  const actions: PathMenuAction[] = [
    { kind: 'selection', label: '建立选区…' },
    { kind: 'fill', label: '填充路径', },
    { kind: 'stroke', label: '描边路径…' },
  ];
  if (row.kind === 'work') {
    actions.push({ kind: 'cmd', label: '存储路径', cmd: 'path.rename', params: { name: 'work', to: freePathName(existingNames) } });
  } else if (row.kind === 'saved' && rowPathJson != null) {
    actions.push({ kind: 'cmd', label: '复制路径', cmd: 'path.set', params: { name: copyPathName(row.name, existingNames), path: rowPathJson } });
  }
  if (row.kind === 'saved') {
    actions.push({ kind: 'rename', label: '重命名路径…' });
  }
  if (row.kind === 'work') {
    actions.push({ kind: 'delete', label: '删除路径', cmd: 'path.delete', params: { name: 'work' } });
  } else if (row.kind === 'saved') {
    actions.push({ kind: 'delete', label: '删除路径', cmd: 'path.delete', params: { name: row.name } });
  } else if (row.name.endsWith('矢量蒙版')) {
    actions.push({ kind: 'delete', label: '删除矢量蒙版', cmd: 'layer.vectorMask.delete', params: {} });
  } else {
    // 形状层的路径即形状本身:删除路径=删除图层(上游 #6552)。层 id 由面板补。
    actions.push({ kind: 'delete', label: '删除路径', cmd: 'layer.delete', params: {} });
  }
  // fill/stroke 需要活动层可画(上游 add_enabled 门)
  return actions.map((a) =>
    (a.kind === 'fill' || a.kind === 'stroke') && !canPaint ? { ...a, disabled: true } : a,
  );
}
