import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  MigrationReport,
  PixcallLibrary,
  listenPixcallProgress,
  pixcallDiscover,
  pixcallImport,
  pixcallProbe,
} from '../../api/tauri-bridge';
import { buildPixcallSummary, reportHasWrites } from '../../utils/pixcallReport';

/**
 * welcome 第 1 步的 PixCall 卡片（设计方案 §6.1 第 3 条）。
 *
 * 语义是**「接管 PixCall 库」**：读注册表拿库根 → 复用现成的切根 + 扫描链
 * （`onTakeover`，await 到扫描结束）→ 自动 probe → import → 结果行。
 * 这正好绕开「第 1 步还没选目录、`file_index` 为空、没东西可匹配」的死结（§6.3 前置条件）。
 *
 * 进度条语义随阶段切换：`switch`（瞬时）→ `scan`（复用现有 scanProgress）→
 * `probe`（读快照解码）→ `import`（迁移进度）→ `done`（结果行）。
 * **不设独立的事前确认弹窗**：合并是纯增量的，重跑安全，报告作为结果展示。
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

  const running = stage === 'switch' || stage === 'scan' || stage === 'probe' || stage === 'import';
  const scanning = stage === 'scan' && isScanning;
  const shown = scanning ? scanProgress ?? null : progress;
  const percent = shown && shown.total > 0 ? Math.min(100, Math.round((shown.processed / shown.total) * 100)) : null;

  const stageLabel =
    stage === 'scan'
      ? scanning
        ? t('welcome.scanning')
        : t('welcome.scanComplete')
      : stage === 'probe'
      ? t('import.probing')
      : stage === 'import'
      ? t('import.importing')
      : stage === 'switch'
      ? t('import.switching')
      : '';

  return (
    <div
      data-testid="welcome-pixcall-card"
      className="mt-6 bg-gray-100 dark:bg-gray-800 p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-center"
    >
      <div className="text-xs text-gray-500 uppercase font-bold mb-1">{t('import.libraryRoot')}</div>
      {stage === 'picking' && libraries.length > 1 && (
        <div className="mt-2 space-y-2">
          <div className="text-xs text-gray-500">{t('import.pickLibrary')}</div>
          {libraries.map(lib => (
            <button
              key={lib.root}
              onClick={() => run(lib)}
              className="block w-full text-sm font-mono truncate px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-white dark:hover:bg-gray-700"
            >
              {lib.root}
            </button>
          ))}
        </div>
      )}
      {active && <div className="text-sm font-mono truncate px-2">{active.root}</div>}
      {!active && stage !== 'picking' && libraries.length === 1 && (
        <div className="text-sm font-mono truncate px-2">{libraries[0].root}</div>
      )}

      {running && (
        <div className="mt-2">
          {percent !== null ? (
            <div>
              <div className="text-xs text-gray-500 mb-1">{`${shown?.processed ?? 0} / ${shown?.total ?? 0}`}</div>
              <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
                <div className="h-2 bg-blue-600 transition-all" style={{ width: `${percent}%` }}></div>
              </div>
            </div>
          ) : (
            <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
              <div className="h-2 bg-blue-600 animate-pulse w-1/3"></div>
            </div>
          )}
          <div className="mt-2 flex items-center justify-center text-blue-600 dark:text-blue-400">
            <Loader2 size={16} className="animate-spin mr-2" />
            <span className="text-xs font-medium">{stageLabel}</span>
          </div>
        </div>
      )}

      {stage === 'done' && report && (
        <div data-testid="welcome-pixcall-result" className="mt-2 text-xs leading-relaxed text-green-700 dark:text-green-400">
          {reportHasWrites(report) ? buildPixcallSummary(report, t) : t('import.nothingFound')}
        </div>
      )}

      {stage === 'error' && error && (
        <div className="mt-2 text-xs leading-relaxed text-red-600 dark:text-red-400">{error}</div>
      )}
    </div>
  );
};

export default WelcomePixcallCard;
