/**
 * 历史资源根（P3，设计方案 v0.3 §8）：记录用户设置过的资源根，切根后可以一键切回。
 *
 * 之所以要单独存一份而不是复用 `user_data.json` 的 `rootPaths`：后者是「当前库内已挂载的根」，
 * 切根时 `handleChangePath` 会把 `files/roots/tabs` 全清，跟着就没了。历史必须挂在
 * `settings.paths` 里才会被 `usePersistence` 一起持久化、且不被切根清空。
 */

/** 历史资源根最多保留的条数（超出丢最久未用的）。 */
export const MAX_ROOT_HISTORY = 10;

/** 去掉首尾空白与结尾的分隔符，便于路径比较（不区分大小写由调用方处理）。 */
export function normalizeRootPath(path: string): string {
  return (path || '').trim().replace(/[\\/]+$/, '');
}

/** 是否是同一个资源根（Windows 路径不区分大小写）。 */
export function isSameRootPath(a: string, b: string): boolean {
  const left = normalizeRootPath(a);
  const right = normalizeRootPath(b);
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * 把一个资源根并入历史：已存在则提到最前（不重复入列），超出上限丢最久未用的。
 * 纯函数，方便单测；返回新数组，不改入参。
 */
export function pushRootHistory(history: string[] | undefined, path: string): string[] {
  const normalized = normalizeRootPath(path);
  if (!normalized) return history ? [...history] : [];

  const rest = (history || []).filter(p => !isSameRootPath(p, normalized));
  return [normalized, ...rest].slice(0, MAX_ROOT_HISTORY);
}

/** 从历史里移除一个资源根。 */
export function removeRootHistory(history: string[] | undefined, path: string): string[] {
  return (history || []).filter(p => !isSameRootPath(p, path));
}

/** 列表里显示的「文件夹名」：路径的最后一段（历史根弹窗要求「名在上、路径在下」）。 */
export function rootDisplayName(path: string): string {
  const normalized = normalizeRootPath(path);
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}
