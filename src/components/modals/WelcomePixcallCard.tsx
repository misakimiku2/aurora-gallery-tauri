import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  MigrationReport,
  PixcallLibrary,
  listenPixcallProgress,
  pixcallDiscover,
  pixcallImport,
  pixcallProbe,
} from '../../api/tauri-bridge';
import { reportHasWrites } from '../../utils/pixcallReport';
import PixcallLibraryRow from '../pixcall/PixcallLibraryRow';
import PixcallProgress from '../pixcall/PixcallProgress';
import PixcallReportView, { PixcallEmptyResult } from '../pixcall/PixcallReportView';

/**
 * welcome 第 1 步的 PixCall 卡片（设计方案 §6.1 第 3 条）。
 *
 * 语义是**「接管 PixCall 库」**：读注册表拿库根 → 复用现成的切根 + 扫描链
 * （`onTakeover`，await 到扫描结束）→ 自动 probe → import → 结果。
 * 这正好绕开「第 1 步还没选目录、`file_index` 为空、没东西可匹配」的死结（§6.3 前置条件）。
 *
 * 进度条语义随阶段切换：`switch`（瞬时）→ `scan`（复用现有 scanProgress）→
 * `probe`（读快照解码）→ `import`（迁移进度）→ `done`（结果）。
 * **不设独立的事前确认弹窗**：合并是纯增量的，重跑安全，报告作为结果展示。
 *
 * 库只印文件夹名，完整路径悬停才出（PixcallLibraryRow）。
 */

interface Props {
  t: (key: string) => string;
  /** 设根 + 扫描，扫完才 resolve */
  onTakeover: (root: string) => Promise<void>;
  scanProgress?: { processed: number; total: number } | null;
  isScanning: boolean;
  /** 导入结束（含「没有可迁内容」）后放开「下一步」；失败不放行 */
  onCompleted: (report: MigrationReport | null) => void;
}

type Stage = 'picking' | 'switch' | 'scan' | 'probe' | 'import' | 'done' | 'error';

const WelcomePixcallCard: React.FC<Props> = ({ t, onTakeover, scanProgress, isScanning, onCompleted }) => {
  const [stage, setStage] = useState<Stage>('picking');
  const [libraries, setLibraries] = useState<PixcallLibrary[]>([]);
  const [active, setActive] = useState<PixcallLibrary | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // 第 1 步还没有「我们的根」，只按注册表发现（§6.3 发现顺序的第 ② 条）
    pixcallDiscover(null)
      .then(libs => {
        if (cancelled) return;
        if (libs.length === 0) {
          setStage('error');
          setError(t('import.noPixcallLibrary'));
          return;
        }
        setLibraries(libs);
        // 单库直接开跑（少一步）；多库才给选择列表（§6.1 第 3 条）
        if (libs.length === 1) void run(libs[0]);
      })
      .catch(e => {
        if (cancelled) return;
        setStage('error');
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const run = async (library: PixcallLibrary) => {
    if (startedRef.current) return;
    startedRef.current = true;
    setActive(library);
    setError(null);
    setReport(null);
    try {
      setStage('switch');
      setStage('scan');
      await onTakeover(library.root);
      setStage('probe');
      await pixcallProbe(library.root);
      setStage('import');
      const result = await pixcallImport(library.root);
      setReport(result);
      setStage('done');
      setProgress(null);
      onCompleted(result);
    } catch (e) {
      setStage('error');
      setProgress(null);
      setError(String(e));
      onCompleted(null);
    } finally {
      startedRef.current = false;
    }
  };

  // `switch` 与 `scan` 是同一次接管的前后两拍，合并成一个「扫描中」的标签
  const scanning = stage === 'switch' || stage === 'scan';
  const running = scanning || stage === 'probe' || stage === 'import';
  const shown = scanning && isScanning ? scanProgress ?? null : progress;
  const percent = shown && shown.total > 0 ? Math.min(100, Math.round((shown.processed / shown.total) * 100)) : null;

  const stageLabel = scanning
    ? isScanning
      ? t('welcome.scanning')
      : t('welcome.scanComplete')
    : stage === 'probe'
    ? t('import.probing')
    : t('import.importing');

  const displayLibrary = active ?? (libraries.length === 1 ? libraries[0] : null);

  return (
    <div
      data-testid="welcome-pixcall-card"
      className="mt-3 rounded-xl border border-gray-200 bg-gray-100 p-3 text-left dark:border-gray-700 dark:bg-gray-800"
    >
      {stage === 'picking' && libraries.length > 1 ? (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('import.pickLibrary')}</div>
          {libraries.map(lib => (
            <PixcallLibraryRow
              key={lib.root}
              root={lib.root}
              isCurrent={lib.isCurrent}
              onClick={() => run(lib)}
              sourceIcon
              t={t}
            />
          ))}
        </div>
      ) : (
        displayLibrary && (
          // 转圈交给下面的进度行，这一行不再重复一个 spinner
          <PixcallLibraryRow root={displayLibrary.root} isCurrent={displayLibrary.isCurrent} sourceIcon t={t} />
        )
      )}

      {running && (
        <div className="mt-3.5">
          <PixcallProgress label={stageLabel} percent={percent} />
        </div>
      )}

      {stage === 'done' && report && (
        <div data-testid="welcome-pixcall-result" className="mt-3">
          {reportHasWrites(report) ? (
            <>
              <div className="flex items-center gap-1.5 text-xs font-bold text-green-600 dark:text-green-400">
                <CheckCircle2 size={14} />
                {t('import.done')}
              </div>
              <div className="mt-2">
                <PixcallReportView report={report} t={t} dense />
              </div>
            </>
          ) : (
            <PixcallEmptyResult report={report} t={t} />
          )}
        </div>
      )}

      {stage === 'error' && error && (
        <div className="mt-3.5 rounded-lg bg-white px-3 py-2.5 text-xs text-red-600 dark:bg-black/20 dark:text-red-400">
          <div className="flex items-start gap-1.5">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
          {libraries.length > 0 && (
            <button
              type="button"
              onClick={() => void run(active ?? libraries[0])}
              className="mt-2 font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            >
              {t('import.retry')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default WelcomePixcallCard;
