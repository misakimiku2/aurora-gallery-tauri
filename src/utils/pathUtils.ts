import md5 from 'md5';

export const normalizePath = (path: string) => path.replace(/\\/g, '/');

export const generateId = (path: string) => md5(normalizePath(path)).substring(0, 9);

/**
 * 是否像绝对路径：Windows 盘符（`C:\` / `C:/`）、UNC（`\\server`）或 Unix 根（`/`）。
 *
 * 用途：拦截「把节点 id 当资源根路径传入」这类误传。`generateId()` 产出的 9 位 hex
 * 不含任何路径分隔符，若被当成根拼进 `${root}/.Aurora_Cache` 便是**相对路径**，
 * 于是会在进程 cwd 下建出游离缓存目录（2026-10-14 实测 `src-tauri/<id>/.Aurora_Cache`）。
 */
export const isAbsolutePath = (p: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
