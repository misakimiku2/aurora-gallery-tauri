import type { FileNode } from '../types';

/**
 * 重扫剪枝(内存治理:AppState.files 无界合并)。
 *
 * scanDirectory 对扫描根返回的是**子树全集**(DB 缓存索引与强制全扫两条路径皆是),
 * 但 scanAndMerge 一类合并点只做 `{...prev.files, ...result.files}`——磁盘上已删除/
 * 被移出的文件节点会永远滞留在内存 Map 里,库越大只增不减。
 *
 * 口径与 handleRefresh 的 traverseAndMark 一致:从扫描根沿**旧 children 数组**圈出
 * 旧子树,剔除其中未被新结果保留的条目。不可达条目不动(保守第一):
 * - parentId=null 的游离节点(LAN 下载落盘件等)不会被剪;
 * - 扫描根不在旧图(首次扫描)时整图原样返回(恒等返回,不产生新对象)。
 */
export function pruneRescannedSubtree(
  prevFiles: Record<string, FileNode>,
  scannedRootIds: string[],
  incoming: Record<string, FileNode>,
): Record<string, FileNode> {
  const stale = new Set<string>();
  let anyRoot = false;
  const walk = (id: string, depth: number) => {
    // 深度上限只防脏数据成环,真实目录树远到不了 64 层
    if (depth > 64 || stale.has(id)) return;
    if (Object.prototype.hasOwnProperty.call(prevFiles, id)) anyRoot = true;
    stale.add(id);
    prevFiles[id]?.children?.forEach((cid) => walk(cid, depth + 1));
  };
  scannedRootIds.forEach((rid) => walk(rid, 0));
  if (!anyRoot) return prevFiles;

  let changed = false;
  const out: Record<string, FileNode> = {};
  for (const [id, node] of Object.entries(prevFiles)) {
    if (stale.has(id) && !Object.prototype.hasOwnProperty.call(incoming, id)) {
      changed = true;
      continue;
    }
    out[id] = node;
  }
  return changed ? out : prevFiles;
}
