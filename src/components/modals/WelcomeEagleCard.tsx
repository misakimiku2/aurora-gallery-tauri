import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FolderInput } from 'lucide-react';
import { EaglePreview, MigrationReport, eagleDiscover, eagleImport, eagleProbe, listenEagleProgress } from '../../api/tauri-bridge';
import { formatImportBytes, reportHasWrites, takeoverTargetFor } from '../../utils/pixcallReport';
import EagleLibraryRow from '../eagle/EagleLibraryRow';
import PixcallProgress from '../pixcall/PixcallProgress';
import PixcallReportView, { PixcallEmptyResult } from '../pixcall/PixcallReportView';

/**
 * welcome 第 1 步的 Eagle 卡片（welcome 第二导入来源）。
 *
 * **语义是「迁移」而不是「接管」**（2026-10-06 验收人定调：我们与 Eagle 是竞品）：
 * 讨论稿 §5 的 C 档——把实体从 `.library` 里搬出来落进用户选的那个资源目录，标签/备注/文件夹
 * 一并带上。
 *
 * ⚠️ 这里刻意**不再调 `onTakeover`（切根 + 扫描）**。照搬 PixCall 那条链在 Eagle 上是错的：
 * Eagle 的库不是图库而是一个数据库目录（图埋在 `images/<ID>.info/` 里，还夹着一张 Eagle 自己的
 * `_thumbnail.png`），把根切到它上面之后网格退化成「N 个文件夹塞着两张图」，实测 49 条目 =
 * 49 个文件夹 / 每张三张缩略图，验收人判定「完全没办法看」。资源根永远由用户自己选
 * （第 1 步那颗「选择文件夹」），Eagle 只往他选好的目录里添文件。
 *
 * 代价与对策：第 1 步还没选目录时没有落地位置，所以卡里直接把「选择资源目录」这条路摆出来，
 * 而不是替他选一个。
 */

interface Props {
  t: (key: string) => string;
  /** 用户还没选目录时的兜底：迁移必须有一个落地位置 */
  onSelectFolder: () => void;
  /** 当前资源根（第 1 步选过目录之后才有）——迁入位置 = `<它>/<库名>` */
  currentRoot: string | null;
  scanProgress?: { processed: number; total: number } | null;
  isScanning: boolean;
  /** 导入结束（含「没有可迁内容」）后放开「下一步」；失败不放行 */
  onCompleted: (report: MigrationReport | null) => void;
  onImported?: () => void;
}

type Stage = 'picking' | 'probing' | 'confirm' | 'takingOver' | 'done' | 'error';

const WelcomeEagleCard: React.FC<Props> = ({
  t,
  onSelectFolder,
  currentRoot,
  scanProgress,
  isScanning,
  onCompleted,
  onImported,
}) => {
  const [stage, setStage] = useState<Stage>('picking');
  const [libraries, setLibraries] = useState<{ root: string; isCurrent: boolean }[]>([]);
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [progressPhase, setProgressPhase] = useState<string | null>(null);
  const [preview, setPreview] = useState<EaglePreview | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preferLink, setPreferLink] = useState(true);
  const startedRef = useRef(false);

  /**
   * 报告视图吃的键前缀是 `import.*`（PixcallReportView 被 PixCall 两处共用、措辞不许各写
   * 一遍）；Eagle 的措辞走 `eagle.*` 的同位键，这里换前缀再交给它（同 EagleImportSection）。
   */
  const reportT = useCallback(
    (key: string) => (key.startsWith('import.') ? t(`eagle.${key.slice('import.'.length)}`) : t(key)),
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    // 第 1 步还没有「我们的根」，只按注册表 / 全盘发现（§6.3 发现顺序的第 ② 条）
    eagleDiscover(null)
      .then(libs => {
        if (cancelled) return;
        if (libs.length === 0) {
          setStage('error');
          setError(t('eagle.noEagleLibrary'));
          return;
        }
        setLibraries(libs);
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
    listenEagleProgress(event => {
      if (event.stage === 'done') {
        setProgress(null);
        setProgressPhase(null);
      } else {
        setProgress({ processed: event.processed, total: event.total });
        setProgressPhase(event.stage);
      }
    })
      .then(fn => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const probe = useCallback(
    async (root: string) => {
      if (startedRef.current) return;
      startedRef.current = true;
      setActiveRoot(root);
      setError(null);
      setReport(null);
      setPreview(null);
      try {
        setStage('probing');
        const target = takeoverTargetFor(currentRoot, root);
        if (!target) {
          setStage('error');
          setError(t('eagle.takeoverNoRoot'));
          return;
        }
        const result = await eagleProbe(root, target, preferLink);
        setPreview(result);
        setStage('confirm');
      } catch (e) {
        setStage('error');
        setError(String(e));
      } finally {
        setProgress(null);
        startedRef.current = false;
      }
    },
    [currentRoot, preferLink, t]
  );

  // 只有一个库时省一步：用户一选好落地位置就自动出预览（多库要先挑一个）
  useEffect(() => {
    if (stage !== 'picking' || !currentRoot || libraries.length !== 1) return;
    void probe(libraries[0].root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, currentRoot, libraries.length]);

  const runImport = useCallback(
    async (root: string, target: string) => {
      startedRef.current = true;
      setError(null);
      setReport(null);
      try {
        setStage('takingOver');
        const result = await eagleImport(root, target, preferLink);
        setReport(result);
        setStage('done');
        onImported?.();
        onCompleted(result);
      } catch (e) {
        setStage('error');
        setError(String(e));
        onCompleted(null);
      } finally {
        setProgress(null);
        startedRef.current = false;
      }
    },
    [onCompleted, onImported, preferLink]
  );

  const running = stage === 'probing' || stage === 'takingOver';
  const shown = running && isScanning ? scanProgress ?? null : progress;
  const percent = shown && shown.total > 0 ? Math.min(100, Math.round((shown.processed / shown.total) * 100)) : null;
  const stageLabel =
    stage === 'probing'
      ? t('eagle.probing')
      : progressPhase === 'import'
        ? t('eagle.importing')
        : t('eagle.takingOver');

  const displayLibrary = activeRoot ?? (libraries.length === 1 ? libraries[0]?.root : null) ?? null;
  const target = displayLibrary ? takeoverTargetFor(currentRoot, displayLibrary) : null;
  const take = preview?.takeover ?? null;
  const incoming = take ? take.toLink + take.toCopy : 0;

  return (
    <div
      data-testid="welcome-eagle-card"
      className="mt-3 rounded-xl border border-gray-200 bg-gray-100 p-3 text-left dark:border-gray-700 dark:bg-gray-800"
    >
      {displayLibrary && (
        <EagleLibraryRow root={displayLibrary} isCurrent={false} sourceIcon t={t} />
      )}

      {!currentRoot && stage !== 'done' && (
        <div className="mt-2.5">
          <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{t('eagle.takeoverNoRoot')}</span>
          </div>
          <button
            type="button"
            data-testid="welcome-eagle-pick-root"
            onClick={onSelectFolder}
            className="mt-2 w-full rounded-lg bg-blue-600 px-3 py-2 text-[11px] font-bold text-white transition-colors hover:bg-blue-700"
          >
            {t('eagle.takeoverPickRoot')}
          </button>
        </div>
      )}

      {/* 多库时这里就是选择列表；单库已经在上面直接开跑（少一步） */}
      {stage === 'picking' && libraries.length > 1 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('eagle.pickLibrary')}</div>
          {libraries.map(lib => (
            <EagleLibraryRow
              key={lib.root}
              root={lib.root}
              isCurrent={lib.isCurrent}
              onClick={() => void probe(lib.root)}
              sourceIcon
              t={t}
            />
          ))}
        </div>
      )}

      {running && (
        <div className="mt-3.5">
          <PixcallProgress label={stageLabel} percent={percent} />
        </div>
      )}

      {stage === 'confirm' && preview && displayLibrary && target && (
        <div data-testid="welcome-eagle-confirm" className="mt-3 rounded-lg bg-white p-3 dark:bg-black/20">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-gray-500 dark:text-gray-400">
            <FolderInput size={13} />
            {t('eagle.takeoverTarget')}
          </div>
          <div className="mt-1 break-all font-mono text-[11px] text-gray-700 dark:text-gray-200" title={target}>
            {target}
          </div>
          {take && incoming > 0 ? (
            <>
              <div className="mt-1.5 text-[11px] text-gray-600 dark:text-gray-300">
                {t('eagle.takeoverSummary')
                  .replace('{total}', String(take.totalItems))
                  .replace('{already}', String(take.alreadyHere))
                  .replace('{incoming}', String(incoming))
                  .replace('{size}', formatImportBytes(take.bytes))}
              </div>
              <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                {take.linkSupported ? t('eagle.takeoverLinkMode') : t('eagle.takeoverCopyMode')}
              </div>
            </>
          ) : (
            <div className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">{t('eagle.takeoverNothing')}</div>
          )}

          <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11px] text-gray-600 select-none dark:text-gray-300">
            <input
              type="checkbox"
              checked={!preferLink}
              onChange={e => setPreferLink(!e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
            />
            <span className="min-w-0">{t('eagle.takeoverAlwaysCopy')}</span>
          </label>

          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              data-testid="welcome-eagle-start"
              onClick={() => void runImport(displayLibrary, target)}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-bold text-white transition-colors hover:bg-blue-700"
            >
              {t('eagle.takeoverStart')}
            </button>
            <button
              type="button"
              onClick={() => setStage('picking')}
              className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200"
            >
              {t('eagle.takeoverCancel')}
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && report && (
        <div data-testid="welcome-eagle-result" className="mt-3">
          {reportHasWrites(report) ? (
            <>
              <div className="flex items-center gap-1.5 text-xs font-bold text-green-600 dark:text-green-400">
                <CheckCircle2 size={14} />
                {t('eagle.done')}
              </div>
              <div className="mt-2">
                <PixcallReportView report={report} t={reportT} dense />
              </div>
            </>
          ) : (
            <PixcallEmptyResult report={report} t={reportT} />
          )}
        </div>
      )}

      {stage === 'error' && error && (
        <div className="mt-3.5 rounded-lg bg-white px-3 py-2.5 text-xs text-red-600 dark:bg-black/20 dark:text-red-400">
          <div className="flex items-start gap-1.5">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
          {displayLibrary && currentRoot && (
            <button
              type="button"
              onClick={() => void probe(displayLibrary)}
              className="mt-2 font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            >
              {t('eagle.retry')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default WelcomeEagleCard;
