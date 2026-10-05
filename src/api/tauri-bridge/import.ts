import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauriEnvironment } from '../../utils/environment';

/**
 * PixCall 标注迁移的前端桥（设计方案 §6.1）。
 *
 * 命令层只做「调用 + 进度事件」，全部规则在 Rust 的 `aurora_core::import` 里。
 * ⑥：PixCall 的 64 位 id 从不过 JSON，所以这里的类型只有计数与字符串。
 */

/**
 * Eagle 标注迁移的前端桥（第二期，Eagle 数据迁移调研 §13.7 拍板记录）。
 *
 * 与 PixCall 完全同构：命令层只做「调用 + 进度事件」，命令名 snake_case 与 Rust 侧
 * `eagle_discover` / `eagle_probe` / `eagle_import` / `eagle_last_import_report` /
 * `eagle_import_records` 一一对应。报告与迁移记录**直接复用** PixCall 期的类型
 * （同一份 `MigrationReport`、同一张 `import_records` 表，`source = 'eagle'`），
 * 唯一新栏是 `unmatchedItems`（H2，serde default，旧 report_json 反序列化不受影响）。
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
  /** 同名命中已有专题、成员并入它的个数（v4.9：不再是「让位不并」） */
  topicsMergedName: number;
  /** 其中原本没有封面、导入时补了一张首图成员个数（已有封面不会被覆盖） */
  topicsCovered: number;
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
  /**
   * Eagle 期新增（调研 §13.7 H2）：未能匹配到我们库里的源**条目名**列表。
   * Rust 侧 `unmatched_items` 带 serde default——PixCall 期的旧 report_json 没有这栏，
   * 反序列化后是 undefined，UI 按缺省跳过（`unmatchedPaths` 保留给 PixCall）。
   */
  unmatchedItems?: string[];
  warnings: string[];
  // ——— C 档「连文件接管」的搬运栏（讨论稿 §5 Q10）———
  // 只有 Eagle 落这些栏；PixCall 与纯 A 档导入恒为 0。
  // Rust 侧带 serde default，旧 `report_json` 反序列化后是 undefined，UI 按缺省跳过。
  /** 同一卷内硬链接进来的条数（不额外占空间） */
  filesLinked?: number;
  /** 硬链接不可用、回退为复制的条数 */
  filesCopied?: number;
  /** 我们库里已经有同一张图 → 没搬，只走挂标注那条路 */
  filesAlreadyHere?: number;
  /** 目标位置已有同名文件（上次搬过）→ 幂等跳过 */
  filesSkippedExisting?: number;
  filesFailed?: number;
  bytesImported?: number;
  takeoverRoot?: string | null;
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

/** 库根与我们当前资源根的位置关系（§6 末「点之前就知道」的提示） */
export type PixcallRootRelation = 'same' | 'inside' | 'outside' | 'unknown';

export interface PixcallLibrary {
  /** PixCall 库根（`.pixcall` 所在目录），与我们当前打开的库根分开建模（§6.3） */
  root: string;
  isCurrent: boolean;
  /**
   * 与资源根的位置关系。`outside` = 这个库的图不在 `file_index` 里，导入不会命中任何文件。
   * 缺省按 `unknown` 处理（welcome 第 1 步还没有根，不该提示）。
   */
  rootRelation?: PixcallRootRelation;
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

/** Eagle 的进度事件与 PixCall 同构（stage / sourceRoot / processed / total），载荷直接复用同一类型 */
export type EagleProgress = PixcallProgress;

/** Eagle 库（`*.library` 目录本身，如 `C:\...\Test.library`）。字段与 PixcallLibrary 同构（调研 §13.7：同一套卡片、同一套关系语义）。 */
export interface EagleLibrary {
  /** Eagle 库根（`.library` 目录），与我们当前打开的库根分开建模（同 PixCall §6.3） */
  root: string;
  isCurrent: boolean;
  /** 与资源根的位置关系，取值与 PixCall 同一套（`same` / `inside` / `outside` / `unknown`） */
  rootRelation?: PixcallRootRelation;
}

/** Eagle 库发现（调研 §1）：找本机的 `*.library` 目录，我们根下的优先；发现不到时 UI 整块不渲染 */
export const eagleDiscover = async (ourRoot?: string | null): Promise<EagleLibrary[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke('eagle_discover', { ourRoot: ourRoot ?? null });
  } catch (e) {
    console.error('Failed to discover Eagle libraries:', e);
    throw e;
  }
};

/** C 档搬运预览：动手之前告诉用户要搬多少、能不能硬链接、占不占空间 */
export interface EagleTakeoverPreview {
  targetRoot: string;
  totalItems: number;
  /** 我们图库里已经有同一张图 → 不搬，只挂标注 */
  alreadyHere: number;
  /** 目标位置已经有这个文件（上次搬过）→ 幂等跳过 */
  skippedExisting: number;
  toLink: number;
  toCopy: number;
  bytes: number;
  /** 目标所在的卷支不支持硬链接（跨盘符 / 网络盘）→ 只能复制 */
  linkSupported: boolean;
  warnings: string[];
}

/** probe 的返回：A 档口径的报告 + C 档口径的搬运预览 */
export interface EaglePreview {
  report: MigrationReport;
  takeover: EagleTakeoverPreview | null;
}

/**
 * Eagle 只读探测：零写入。**给 `targetRoot` 就顺带算搬运预览**——往用户资源根里写文件之前，
 * 先给一眼「要搬多少条、占不占空间」的账。快照留在 Rust 侧供 import 复用（同 PixCall §6.2 末）。
 */
export const eagleProbe = async (
  sourceRoot: string,
  targetRoot?: string | null,
  preferLink?: boolean
): Promise<EaglePreview> => {
  if (!isTauriEnvironment()) throw new Error('not in tauri');
  try {
    return await invoke('eagle_probe', {
      sourceRoot,
      targetRoot: targetRoot ?? null,
      preferLink: preferLink ?? true,
    });
  } catch (e) {
    console.error('Failed to probe Eagle library:', e);
    throw e;
  }
};

/**
 * Eagle 执行迁移：**给 `targetRoot` 就是 C 档**——先把实体从 `.library` 里剥出来落进
 * 用户的资源根，再复用 A 档的认亲链挂标注；不给就是纯 A 档（图已经在我们库里）。
 * 纯增量、重跑安全（同 PixCall §6.1 第 2/3 条）。
 */
export const eagleImport = async (
  sourceRoot: string,
  targetRoot?: string | null,
  preferLink?: boolean
): Promise<MigrationReport> => {
  if (!isTauriEnvironment()) throw new Error('not in tauri');
  try {
    return await invoke('eagle_import', {
      sourceRoot,
      targetRoot: targetRoot ?? null,
      preferLink: preferLink ?? true,
    });
  } catch (e) {
    console.error('Failed to import from Eagle:', e);
    throw e;
  }
};

/** 某个 Eagle 库根的最近一条导入记录（Rust `eagle_last_import_report`；「上次导入报告」的数据源） */
export const eagleLastImportReport = async (sourceRoot: string): Promise<ImportRecord | null> => {
  if (!isTauriEnvironment()) return null;
  try {
    return await invoke('eagle_last_import_report', { sourceRoot });
  } catch (e) {
    console.error('Failed to read last Eagle import report:', e);
    return null;
  }
};

/** Eagle 的全部导入记录（`import_records.source = 'eagle'`），按时间倒序；第一条就是「上次导入报告」 */
export const eagleImportRecords = async (): Promise<ImportRecord[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke('eagle_import_records');
  } catch (e) {
    console.error('Failed to read Eagle import records:', e);
    return [];
  }
};

export const listenEagleProgress = async (
  onProgress: (progress: EagleProgress) => void
): Promise<UnlistenFn> => {
  if (!isTauriEnvironment()) return () => {};
  return listen<EagleProgress>('eagle-progress', (event) => onProgress(event.payload));
};
