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
}

type Stage = 'idle' | 'probing' | 'importing' | 'done' | 'error';

/** `import_records.report_json` 是历史数据，坏一行不该让整块入口消失（§6.5） */
const parseReport = (json: string): MigrationReport | null => {
  try {
    return JSON.parse(json) as MigrationReport;
  } catch {
    return null;
  }
};

const PixcallImportSection: React.FC<Props> = ({ t, currentRoot, onShowToast }) => {
  const [libraries, setLibraries] = useState<PixcallLibrary[]>([]);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRecord, setLastRecord] = useState<ImportRecord | null>(null);
  const [showLastReport, setShowLastReport] = useState(false);
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
    async (root: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setActiveRoot(root);
      setError(null);
      setReport(null);
      try {
        setStage('probing');
        await pixcallProbe(root);
        setStage('importing');
        const result = await pixcallImport(root);
        setReport(result);
        setStage('done');
        setProgress(null);
        setLastRecord(await pixcallImportRecords().then(rows => (rows.length > 0 ? rows[0] : null)));
        if (!result) return;
        onShowToast?.(t('import.doneToast'));
      } catch (e) {
        setStage('error');
        setProgress(null);
        setError(String(e));
      } finally {
        busyRef.current = false;
      }
    },
    [onShowToast, t]
  );

  if (libraries.length === 0) return null;

  const busy = stage === 'probing' || stage === 'importing';
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
                onClick={() => run(lib.root)}
                busy={busy && activeRoot === lib.root}
                disabled={busy}
                t={t}
              />
            ))}
          </div>

          {busy && (
            <div className="mt-4">
              <PixcallProgress
                label={stage === 'probing' ? t('import.probing') : t('import.importing')}
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
    </div>
  );
};

export default PixcallImportSection;
