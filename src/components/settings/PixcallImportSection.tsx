import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Import, AlertCircle } from 'lucide-react';
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
  buildPixcallSummary as buildSummary,
  fillTemplate as replace,
  reportHasWrites,
} from '../../utils/pixcallReport';

/**
 * 设置 → 存储面板的「使用 PixCall 库」（设计方案 §6.1 第 4 条）。
 *
 * 这颗按钮的语义与 welcome 那颗**不同**：根目录已经定好了，只往当前打开的库里叠标注，
 * 不重设根目录，所以文案也不该一样。
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

/* §4.7 各栏的文案口径与 welcome 卡片共用一处实现（utils/pixcallReport），两处不许各写一遍 */

const PixcallImportSection: React.FC<Props> = ({ t, currentRoot, onShowToast }) => {
  const [libraries, setLibraries] = useState<PixcallLibrary[]>([]);
  const [stage, setStage] = useState<Stage>('idle');
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
      .then((libs) => {
        if (!cancelled) setLibraries(libs);
      })
      .catch(() => {
        if (!cancelled) setLibraries([]);
      });
    pixcallImportRecords()
      .then((rows) => {
        if (!cancelled) setLastRecord(rows.length > 0 ? rows[0] : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentRoot]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenPixcallProgress((event) => {
      if (event.stage === 'done') setProgress(null);
      else setProgress({ processed: event.processed, total: event.total });
    })
      .then((fn) => {
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
        setLastRecord(await pixcallImportRecords().then((rows) => (rows.length > 0 ? rows[0] : null)));
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

  return (
    <div className="mt-4">
      <div className="flex items-center space-x-4">
        {/* 多于一个库时先选（§6.1 第 3 条：多库给选择列表） */}
        {libraries.length === 1 ? (
          <button
            onClick={() => run(libraries[0].root)}
            disabled={busy}
            className="flex items-center px-4 py-2 bg-surface hover:bg-surface/70 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-subtle disabled:opacity-50"
          >
            <Import size={16} className="mr-2" />
            {busy ? t('import.running') : t('settings.usePixcallLibrary')}
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-gray-500 dark:text-gray-400">{t('import.pickLibrary')}</div>
            <div className="flex flex-wrap gap-2">
              {libraries.map((lib) => (
                <button
                  key={lib.root}
                  onClick={() => run(lib.root)}
                  disabled={busy}
                  className="flex items-center px-3 py-1.5 bg-surface hover:bg-surface/70 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-subtle disabled:opacity-50 text-sm"
                >
                  <Import size={14} className="mr-2" />
                  {lib.root}
                  {lib.isCurrent ? ' ★' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
        {lastRecord && (
          <button
            onClick={() => setShowLastReport((v) => !v)}
            className="flex items-center text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
          >
            {showLastReport ? <ChevronUp size={14} className="mr-1" /> : <ChevronDown size={14} className="mr-1" />}
            {t('import.lastReport')}
          </button>
        )}
      </div>

      {busy && (
        <div className="mt-3 max-w-md">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
            {stage === 'probing' ? t('import.probing') : t('import.importing')}
            {percent !== null ? ` ${percent}%` : ''}
          </div>
          <div className="h-1.5 w-full bg-gray-200 dark:bg-neutral-700 rounded-full overflow-hidden">
            <div
              className={`h-full bg-blue-500 transition-all ${percent === null ? 'animate-pulse w-1/3' : ''}`}
              style={percent !== null ? { width: `${percent}%` } : undefined}
            />
          </div>
        </div>
      )}

      {stage === 'error' && error && (
        <div className="mt-3 flex items-start text-sm text-red-600 dark:text-red-400 max-w-2xl">
          <AlertCircle size={16} className="mr-2 mt-0.5 flex-shrink-0" />
          <span>{replace(t('import.failed'), { message: error })}</span>
        </div>
      )}

      {stage === 'done' && report && (
        <div className="mt-3 text-sm text-gray-700 dark:text-gray-200 max-w-3xl leading-relaxed">
          {reportHasWrites(report) ? buildSummary(report, t) : t('import.nothingFound')}
        </div>
      )}

      {showLastReport && lastRecord && (
        <div className="mt-3 p-3 rounded-lg bg-surface/60 border border-subtle max-w-3xl">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {replace(t('import.reportAt'), {
              time: new Date(lastRecord.importedAt * 1000).toLocaleString(),
              root: lastRecord.sourceRoot,
            })}
          </div>
          <div className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
            {(() => {
              try {
                const parsed = JSON.parse(lastRecord.reportJson) as MigrationReport;
                return (
                  <div className="space-y-1">
                    <div>{buildSummary(parsed, t)}</div>
                    {/* welcome 卡片只给计数，名字明细在这一层（v4.5 拍板 A） */}
                    {parsed.excludedTrashNames.length > 0 && (
                      <ul className="list-disc list-inside text-xs text-gray-500 dark:text-gray-400">
                        {parsed.excludedTrashNames.map((item) => (
                          <li key={item.name}>
                            {item.originFolder
                              ? replace(t('import.trashItemWithOrigin'), {
                                  name: item.name,
                                  folder: item.originFolder,
                                })
                              : replace(t('import.trashItem'), { name: item.name })}
                          </li>
                        ))}
                      </ul>
                    )}
                    {parsed.warnings.length > 0 && (
                      <ul className="list-disc list-inside text-xs text-gray-500 dark:text-gray-400">
                        {parsed.warnings.map((warning, index) => (
                          <li key={index}>{warning}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              } catch {
                return <span>{t('import.reportUnreadable')}</span>;
              }
            })()}
          </div>
        </div>
      )}
    </div>
  );
};

export default PixcallImportSection;
