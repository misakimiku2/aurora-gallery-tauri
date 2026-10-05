import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import {
  MigrationReport,
  PixcallLibrary,
  ImportRecord,
  pixcallDiscover,
  pixcallImport,
  pixcallImportRecords,
  pixcallProbe,
  listenPixcallProgress,
} from '../../api/tauri-bridge';
import {
  fillTemplate,
  libraryDisplayName,
  reportHasWrites,
} from '../../utils/pixcallReport';
import PixcallLibraryRow from '../pixcall/PixcallLibraryRow';
import PixcallLogo from '../pixcall/PixcallLogo';
import PixcallProgress from '../pixcall/PixcallProgress';
import PixcallReportView, { PixcallEmptyResult } from '../pixcall/PixcallReportView';
import SwitchRootConfirmDialog from './SwitchRootConfirmDialog';

/**
 * 设置 → 存储面板的「从 PixCall 导入标注」（设计方案 §6.1 第 4 条）。
 *
 * 这颗入口的语义与 welcome 那颗**不同**：根目录已经定好了，只往当前打开的库里叠标注，
 * 不重设根目录，所以文案也不该一样。
 *
 * **默认折叠成一行**：后续还要接 Eagle 等来源，它们会排成同一列卡片，所以这里既不能摊开、
 * 也不能占宽（宽度由 StoragePanel 那一层收）。点开才出库列表、进度与报告。
 *
 * 不设事前确认弹窗：合并是纯增量的（并集 / 仅为空时填 / 同名不新建 / position 续排），
 * 重跑安全，报告作为**结果**展示。probe 发现 0 条可迁标注时不写迁移记录。
 */

interface Props {
  t: (key: string) => string;
  /** 我们当前打开的库根，用于优先匹配同一目录下的 .pixcall（§6.3） */
  currentRoot?: string | null;
  onShowToast?: (msg: string, duration?: number) => void;
  /**
   * 导入**写库成功之后**回调。导入是 Rust 侧直接写 `file_metadata`，不经过前端 state，
   * 不回读一次的话详情页还停在旧值（2026-10-05 实测：库里已有 3 条来源网址，
   * 界面仍只显示导入前的 2 条）。
   */
  onImported?: () => void;
  /**
   * 切根 + 扫描（await 到扫完），与设置里「历史资源根」同一个 `switchToRoot` 链路。
   *
   * §13 场景 C 要用：当前资源根跟这个库没有包含关系时，先切过去再导入，
   * 否则源侧每一条都落进 unmatched。**只在 outside 时调**，same/inside 照旧不切根。
   */
  onSwitchRoot?: (path: string) => void | Promise<void>;
}

type Stage = 'idle' | 'switching' | 'probing' | 'importing' | 'done' | 'error';

/** `import_records.report_json` 是历史数据，坏一行不该让整块入口消失（§6.5） */
const parseReport = (json: string): MigrationReport | null => {
  try {
    return JSON.parse(json) as MigrationReport;
  } catch {
    return null;
  }
};

const PixcallImportSection: React.FC<Props> = ({ t, currentRoot, onShowToast, onImported, onSwitchRoot }) => {
  const [libraries, setLibraries] = useState<PixcallLibrary[]>([]);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRecord, setLastRecord] = useState<ImportRecord | null>(null);
  const [showLastReport, setShowLastReport] = useState(false);
  /**
   * §13 场景 C：点了一个 `outside` 的库 → 先弹切根确认（与手动换根同一个弹窗）。
   * 记的是整个库对象，不只是路径——弹窗上要印库名，确认后才知道要切到哪。
   */
  const [pendingSwitchLibrary, setPendingSwitchLibrary] = useState<PixcallLibrary | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // 发现不到 PixCall 库就整块不渲染——不留一颗点了报错的按钮
    pixcallDiscover(currentRoot ?? null)
      .then(libs => {
        if (!cancelled) setLibraries(libs);
      })
      .catch(() => {
        if (!cancelled) setLibraries([]);
      });
    pixcallImportRecords()
      .then(rows => {
        if (!cancelled) setLastRecord(rows.length > 0 ? rows[0] : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentRoot]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenPixcallProgress(event => {
      if (event.stage === 'done') setProgress(null);
      else setProgress({ processed: event.processed, total: event.total });
    })
      .then(fn => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const run = useCallback(
    async (root: string, options?: { switchRootFirst?: boolean }) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setActiveRoot(root);
      setError(null);
      setReport(null);
      try {
        // §13 场景 C：确认之后先切根（切根链自带扫描且 await 到扫完），
        // 不扫完 file_index 是空的，probe 会一条都命中不了
        if (options?.switchRootFirst && onSwitchRoot) {
          setStage('switching');
          await onSwitchRoot(root);
        }
        setStage('probing');
        await pixcallProbe(root);
        setStage('importing');
        const result = await pixcallImport(root);
        setReport(result);
        setStage('done');
        setProgress(null);
        setLastRecord(await pixcallImportRecords().then(rows => (rows.length > 0 ? rows[0] : null)));
        if (!result) return;
        // 库已经写完了，把内存里的 files 拉回一致（否则详情页看到的还是导入前的值）
        onImported?.();
        onShowToast?.(t('import.doneToast'));
      } catch (e) {
        setStage('error');
        setProgress(null);
        setError(String(e));
      } finally {
        busyRef.current = false;
      }
    },
    [onImported, onShowToast, onSwitchRoot, t]
  );

  /**
   * §13 的三分器落地：`outside`（库不在我们的根下）先弹切根确认再导，
   * `same` / `inside`（同一个目录或库是根的子目录）照旧直接导，不动根目录。
   */
  const pickLibrary = useCallback(
    (lib: PixcallLibrary) => {
      if (lib.rootRelation === 'outside' && onSwitchRoot) {
        setPendingSwitchLibrary(lib);
        return;
      }
      void run(lib.root);
    },
    [onSwitchRoot, run]
  );

  const confirmSwitchAndImport = useCallback(async () => {
    const lib = pendingSwitchLibrary;
    if (!lib) return;
    setPendingSwitchLibrary(null);
    await run(lib.root, { switchRootFirst: true });
  }, [pendingSwitchLibrary, run]);

  if (libraries.length === 0) return null;

  const busy = stage === 'switching' || stage === 'probing' || stage === 'importing';
  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : null;
  // 折叠那一行也要能判断「这台机器导过没有」，不用点开
  const subtitle = lastRecord
    ? fillTemplate(t('import.lastImported'), {
        time: new Date(lastRecord.importedAt * 1000).toLocaleDateString(),
      })
    : fillTemplate(t('import.foundLibraries'), { count: libraries.length });
  // 展开时才解报告；解不出来留一句提示，不整块消失。
  // 这里不能用 hook：上面有一句提前 return，hook 数量会随渲染次数变（React 直接炸）
  const lastReport = lastRecord ? parseReport(lastRecord.reportJson) : null;

  return (
    <div className="overflow-hidden rounded-xl border border-subtle bg-surface">
      <button
        type="button"
        aria-expanded={open}
        data-testid="pixcall-source-header"
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50 dark:hover:bg-white/5"
      >
        <PixcallLogo size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-gray-800 dark:text-white">
            {t('settings.importFromPixcall')}
          </span>
          <span className="block truncate text-[11px] text-gray-500 dark:text-gray-400">{subtitle}</span>
        </span>
        {open ? (
          <ChevronUp size={15} className="shrink-0 text-gray-400 dark:text-gray-500" />
        ) : (
          <ChevronDown size={15} className="shrink-0 text-gray-400 dark:text-gray-500" />
        )}
      </button>

      {open && (
        <div className="border-t border-subtle px-4 pb-4 pt-3">
          <p className="mb-2.5 text-[11px] text-gray-500 dark:text-gray-400">
            {t('settings.importFromPixcallHint')}
          </p>

          {/* 点一行就从该库导入；多库时这里就是 §6.1 的选择列表 */}
          <div className="space-y-1.5">
            {libraries.map(lib => (
              <PixcallLibraryRow
                key={lib.root}
                root={lib.root}
                isCurrent={lib.isCurrent}
                relation={lib.rootRelation}
                onClick={() => pickLibrary(lib)}
                busy={busy && activeRoot === lib.root}
                disabled={busy}
                t={t}
              />
            ))}
          </div>

          {busy && (
            <div className="mt-4">
              <PixcallProgress
                label={stage === 'switching'
                  ? t('import.switchingRoot')
                  : stage === 'probing'
                    ? t('import.probing')
                    : t('import.importing')}
                percent={percent}
              />
            </div>
          )}

          {stage === 'error' && error && (
            <div className="mt-4 flex items-start gap-1.5 rounded-lg bg-white px-3 py-2.5 text-xs text-red-600 dark:bg-black/20 dark:text-red-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{fillTemplate(t('import.failed'), { message: error })}</span>
            </div>
          )}

          {stage === 'done' && report && (
            <div className="mt-4">
              {reportHasWrites(report) ? (
                <PixcallReportView report={report} t={t} />
              ) : (
                <PixcallEmptyResult report={report} t={t} />
              )}
            </div>
          )}

          {lastRecord && (
            <>
              <button
                type="button"
                onClick={() => setShowLastReport(value => !value)}
                className="mt-3.5 flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:bg-white hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 dark:text-gray-400 dark:hover:bg-black/20 dark:hover:text-gray-200"
              >
                {showLastReport ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {t('import.lastReport')}
              </button>

              {showLastReport && (
                <div className="mt-2 rounded-lg bg-white p-3.5 dark:bg-black/20">
                  <div className="text-[11px] font-medium text-gray-400 dark:text-gray-500" title={lastRecord.sourceRoot}>
                    {fillTemplate(t('import.reportAt'), {
                      time: new Date(lastRecord.importedAt * 1000).toLocaleString(),
                      root: libraryDisplayName(lastRecord.sourceRoot),
                    })}
                  </div>
                  <div className="mt-2.5">
                    {lastReport ? (
                      // welcome 只给计数，回收站名字与 warnings 明细在这一层（v4.5 拍板 A）
                      <PixcallReportView report={lastReport} t={t} detailed />
                    ) : (
                      <div className="text-xs text-gray-500 dark:text-gray-400">{t('import.reportUnreadable')}</div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* §13 场景 C：点 outside 的库时先弹这个（与手动换根共用同一组件与文案）。
          用 Portal 渲染，挂在 fragment 里不影响上面卡片的 DOM 结构。 */}
      <SwitchRootConfirmDialog
        targetPath={pendingSwitchLibrary ? pendingSwitchLibrary.root : null}
        busy={stage === 'switching'}
        onCancel={() => setPendingSwitchLibrary(null)}
        onConfirm={confirmSwitchAndImport}
        t={t}
      />
    </div>
  );
};

export default PixcallImportSection;
