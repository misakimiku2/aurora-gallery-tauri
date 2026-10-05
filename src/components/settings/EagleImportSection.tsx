import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import {
  MigrationReport,
  EagleLibrary,
  ImportRecord,
  eagleDiscover,
  eagleImport,
  eagleImportRecords,
  eagleProbe,
  listenEagleProgress,
} from '../../api/tauri-bridge';
import {
  fillTemplate,
  libraryDisplayName,
  reportHasWrites,
} from '../../utils/pixcallReport';
import EagleLibraryRow from '../eagle/EagleLibraryRow';
import EagleLogo from '../eagle/EagleLogo';
import PixcallProgress from '../pixcall/PixcallProgress';
import PixcallReportView, { PixcallEmptyResult } from '../pixcall/PixcallReportView';
import SwitchRootConfirmDialog from './SwitchRootConfirmDialog';

/**
 * 设置 → 存储面板的「从 Eagle 导入标注」（Eagle 数据迁移调研 §10 ④：与 PixCall 同一张
 * 折叠列表里的第二张卡，v4.13 口径：整宽、同构、不再各自定宽）。
 *
 * 结构与状态机**照抄 PixcallImportSection**：发现库 → probe 预览 → 导入 → 最近报告查看
 * → 历史记录。Eagle 的库是一个 `*.library` 目录本身（如 `C:\...\Test.library`）。
 * 这颗入口的语义与 PixCall 卡一致：根目录已经定好，只往当前打开的库里叠标注
 * （P1 拍板的 A 档），不重设根目录。
 *
 * **默认折叠成一行**：与 PixCall 卡排同一条列表，宽度由 StoragePanel 那一层收。
 * 点开才出库列表、进度与报告。
 *
 * 不设事前确认弹窗：合并是纯增量的（并集 / 仅为空时填 / 同名不新建 / position 续排），
 * 重跑安全，报告作为**结果**展示。probe 发现 0 条可迁标注时不写迁移记录。
 *
 * 报告展示**直接复用** PixcallReportView（吃的是同一份 MigrationReport，没必要复制两份）：
 * 它内部取 `import.*` 的通用键，这里把键前缀换成 `eagle.*` 再交给它——薄包装，
 * 报告组件一行不改；Eagle 专属措辞（条目/智能文件夹/品牌名）落在 eagle 命名空间的同位键上。
 */

interface Props {
  t: (key: string) => string;
  /** 我们当前打开的库根，用于优先匹配同一目录下的 `*.library` */
  currentRoot?: string | null;
  onShowToast?: (msg: string, duration?: number) => void;
  /**
   * 导入**写库成功之后**回调。导入是 Rust 侧直接写 `file_metadata`，不经过前端 state，
   * 不回读一次的话详情页还停在旧值（与 PixCall 同一个坑）。上层传的是同一条
   * 「回读元数据」回调（StoragePanel 的 onPixcallImported，名字历史原因）。
   */
  onImported?: () => void;
  /**
   * 切根 + 扫描（await 到扫完），与设置里「历史资源根」同一个 `switchToRoot` 链路。
   *
   * 库根跟当前资源根没有包含关系时，先切过去再导入，否则源侧每一条都落进 unmatched。
   * **只在 outside 时调**，same/inside 照旧不切根。
   */
  onSwitchRoot?: (path: string) => void | Promise<void>;
}

type Stage = 'idle' | 'switching' | 'probing' | 'importing' | 'done' | 'error';

/** `import_records.report_json` 是历史数据，坏一行不该让整块入口消失（同 PixCall §6.5） */
const parseReport = (json: string): MigrationReport | null => {
  try {
    return JSON.parse(json) as MigrationReport;
  } catch {
    return null;
  }
};

const EagleImportSection: React.FC<Props> = ({ t, currentRoot, onShowToast, onImported, onSwitchRoot }) => {
  const [libraries, setLibraries] = useState<EagleLibrary[]>([]);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRecord, setLastRecord] = useState<ImportRecord | null>(null);
  const [showLastReport, setShowLastReport] = useState(false);
  /**
   * 点了一个 `outside` 的库 → 先弹切根确认（与手动换根同一个弹窗）。
   * 记的是整个库对象，不只是路径——弹窗上要印库名，确认后才知道要切到哪。
   */
  const [pendingSwitchLibrary, setPendingSwitchLibrary] = useState<EagleLibrary | null>(null);
  const busyRef = useRef(false);

  /**
   * 报告视图吃的键前缀是 `import.*`（它被 PixCall 两处共用、措辞不许各写一遍）；
   * Eagle 的措辞走 `eagle.*` 的同位键，这里换前缀再交给它。
   */
  const reportT = useCallback(
    (key: string) => (key.startsWith('import.') ? t(`eagle.${key.slice('import.'.length)}`) : t(key)),
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    // 发现不到 Eagle 库就整块不渲染——不留一颗点了报错的按钮
    eagleDiscover(currentRoot ?? null)
      .then(libs => {
        if (!cancelled) setLibraries(libs);
      })
      .catch(() => {
        if (!cancelled) setLibraries([]);
      });
    eagleImportRecords()
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
    listenEagleProgress(event => {
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
        // 确认之后先切根（切根链自带扫描且 await 到扫完），
        // 不扫完 file_index 是空的，probe 会一条都命中不了
        if (options?.switchRootFirst && onSwitchRoot) {
          setStage('switching');
          await onSwitchRoot(root);
        }
        setStage('probing');
        await eagleProbe(root);
        setStage('importing');
        const result = await eagleImport(root);
        setReport(result);
        setStage('done');
        setProgress(null);
        setLastRecord(await eagleImportRecords().then(rows => (rows.length > 0 ? rows[0] : null)));
        if (!result) return;
        // 库已经写完了，把内存里的 files 拉回一致（否则详情页看到的还是导入前的值）
        onImported?.();
        onShowToast?.(t('eagle.doneToast'));
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
   * 三分器与 PixCall 同款：`outside`（库不在我们的根下）先弹切根确认再导，
   * `same` / `inside`（同一个目录或库是根的子目录）照旧直接导，不动根目录。
   */
  const pickLibrary = useCallback(
    (lib: EagleLibrary) => {
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
    ? fillTemplate(t('eagle.lastImported'), {
        time: new Date(lastRecord.importedAt * 1000).toLocaleDateString(),
      })
    : fillTemplate(t('eagle.foundLibraries'), { count: libraries.length });
  // 展开时才解报告；解不出来留一句提示，不整块消失。
  // 这里不能用 hook：上面有一句提前 return，hook 数量会随渲染次数变（React 直接炸）
  const lastReport = lastRecord ? parseReport(lastRecord.reportJson) : null;

  return (
    <div className="overflow-hidden rounded-xl border border-subtle bg-surface">
      <button
        type="button"
        aria-expanded={open}
        data-testid="eagle-source-header"
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50 dark:hover:bg-white/5"
      >
        <EagleLogo size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-gray-800 dark:text-white">
            {t('settings.importFromEagle')}
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
            {t('settings.importFromEagleHint')}
          </p>

          {/* 点一行就从该库导入；多库时这里就是选择列表 */}
          <div className="space-y-1.5">
            {libraries.map(lib => (
              <EagleLibraryRow
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
                  ? t('eagle.switchingRoot')
                  : stage === 'probing'
                    ? t('eagle.probing')
                    : t('eagle.importing')}
                percent={percent}
              />
            </div>
          )}

          {stage === 'error' && error && (
            <div className="mt-4 flex items-start gap-1.5 rounded-lg bg-white px-3 py-2.5 text-xs text-red-600 dark:bg-black/20 dark:text-red-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{fillTemplate(t('eagle.failed'), { message: error })}</span>
            </div>
          )}

          {stage === 'done' && report && (
            <div className="mt-4">
              {reportHasWrites(report) ? (
                <PixcallReportView report={report} t={reportT} />
              ) : (
                <PixcallEmptyResult report={report} t={reportT} />
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
                {t('eagle.lastReport')}
              </button>

              {showLastReport && (
                <div className="mt-2 rounded-lg bg-white p-3.5 dark:bg-black/20">
                  <div className="text-[11px] font-medium text-gray-400 dark:text-gray-500" title={lastRecord.sourceRoot}>
                    {fillTemplate(t('eagle.reportAt'), {
                      time: new Date(lastRecord.importedAt * 1000).toLocaleString(),
                      root: libraryDisplayName(lastRecord.sourceRoot),
                    })}
                  </div>
                  <div className="mt-2.5">
                    {lastReport ? (
                      // 与 PixCall 同款：折叠摘要给计数，回收站名字与 warnings 明细在这一层
                      <PixcallReportView report={lastReport} t={reportT} detailed />
                    ) : (
                      <div className="text-xs text-gray-500 dark:text-gray-400">{t('eagle.reportUnreadable')}</div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 点 outside 的库时先弹这个（与手动换根共用同一组件与文案）。
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

export default EagleImportSection;
