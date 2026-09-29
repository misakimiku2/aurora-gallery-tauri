import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriEnvironment } from '../../utils/environment';

/**
 * PixCall 标注迁移的前端桥（设计方案 §6.1）。
 *
 * 命令层只做「调用 + 进度事件」，全部规则在 Rust 的 `aurora_core::import` 里。
 * ⑥：PixCall 的 64 位 id 从不过 JSON，所以这里的类型只有计数与字符串。
 */

/** §4.7 的 MigrationReport，Rust 侧 `#[serde(rename_all = "camelCase")]` */
export interface MigrationReport {
  matched: number;
  tagsUnioned: number;
  tagsWordsAdded: number;
  descriptionsWritten: number;
  descriptionsSkippedExisting: number;
  sourceUrlsWritten: number;
  sourceUrlsSkippedExisting: number;
  topicsCreated: number;
  topicFilesAdded: number;
  topicsSkippedName: number;
  topicsMaterialized: number;
  topicsSkippedUnverifiable: number;
  topicsReparented: number;
  skippedUnsupportedType: number;
  annotatedUnsupported: number;
  topicMembersSkippedType: number;
  excludedTrash: number;
  excludedTrashNames: Array<{ name: string; originFolder?: string }>;
  unmatched: number;
  unmatchedPaths: string[];
  warnings: string[];
}

/** §6.5 迁移记录（跟着库走）。`reportJson` 是上面那份报告的序列化。 */
export interface ImportRecord {
  id: number;
  source: string;
  sourceRoot: string;
  sourceSchemaVersion: string;
  importedAt: number;
  reportJson: string;
  matched: number;
  unmatched: number;
  skippedExisting: number;
  skippedUnsupportedType: number;
  topicMembersSkippedType: number;
}

export interface PixcallLibrary {
  /** PixCall 库根（`.pixcall` 所在目录），与我们当前打开的库根分开建模（§6.3） */
  root: string;
  isCurrent: boolean;
}

export interface PixcallProgress {
  /** switch / scan 由现有扫描链路驱动，这里只发 probe / import / done */
  stage: 'probe' | 'import' | 'done';
  sourceRoot: string;
  processed: number;
  total: number;
}

/** §6.3 发现顺序：我们根下的 `.pixcall` 优先，其次注册表，且过滤掉没建库的条目 */
export const pixcallDiscover = async (ourRoot?: string | null): Promise<PixcallLibrary[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke('pixcall_discover', { ourRoot: ourRoot ?? null });
  } catch (e) {
    console.error('Failed to discover PixCall libraries:', e);
    throw e;
  }
};

/** 只读探测：零写入，返回报告；快照留在 Rust 侧供 import 复用（§6.2 末） */
export const pixcallProbe = async (sourceRoot: string): Promise<MigrationReport> => {
  if (!isTauriEnvironment()) throw new Error('not in tauri');
  try {
    return await invoke('pixcall_probe', { sourceRoot });
  } catch (e) {
    console.error('Failed to probe PixCall library:', e);
    throw e;
  }
};

/** 执行导入：纯增量、重跑安全（§6.1 第 2/3 条） */
export const pixcallImport = async (sourceRoot: string): Promise<MigrationReport> => {
  if (!isTauriEnvironment()) throw new Error('not in tauri');
  try {
    return await invoke('pixcall_import', { sourceRoot });
  } catch (e) {
    console.error('Failed to import from PixCall:', e);
    throw e;
  }
};

/** 本库的全部导入记录，按时间倒序；第一条就是「上次导入报告」 */
export const pixcallImportRecords = async (): Promise<ImportRecord[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke('pixcall_import_records');
  } catch (e) {
    console.error('Failed to read import records:', e);
    return [];
  }
};

export const listenPixcallProgress = async (
  onProgress: (progress: PixcallProgress) => void
): Promise<UnlistenFn> => {
  if (!isTauriEnvironment()) return () => {};
  return listen<PixcallProgress>('pixcall-progress', (event) => onProgress(event.payload));
};
