import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, FolderInput } from 'lucide-react';
import {
  MigrationReport,
  EagleLibrary,
  EaglePreview,
  ImportRecord,
  eagleDiscover,
  eagleImport,
  eagleImportRecords,
  eagleProbe,
  listenEagleProgress,
} from '../../api/tauri-bridge';
import {
  fillTemplate,
  formatImportBytes,
  libraryDisplayName,
  reportHasWrites,
  takeoverTargetFor,
} from '../../utils/pixcallReport';
import EagleLibraryRow from '../eagle/EagleLibraryRow';
import EagleLogo from '../eagle/EagleLogo';
import PixcallProgress from '../pixcall/PixcallProgress';
import PixcallReportView, { PixcallEmptyResult } from '../pixcall/PixcallReportView';

/**
 * 设置 → 存储面板的「从 Eagle 迁移」（Eagle 数据迁移调研 §10 ④：与 PixCall 同一张
 * 折叠列表里的第二张卡，v4.13 口径：整宽、同构、不再各自定宽）。
 *
 * **语义变了**（2026-10-06 验收人定调：我们与 Eagle 是竞品，迁移的完成标准是用户搬完之后
 * 图库能独立存在）：这里是讨论稿 §5 的 **C 档「连文件接管」**——把实体从 `.library` 里
 * 剥出来、剥掉 `<ID>.info` 这层目录与 `_thumbnail.png`，按 Eagle 的夹结构落进**当前资源根**，
 * 之后再走 A 档的认亲链挂标注。
 *
 * 两条因此不一样的地方：
 * 1. **不再切换资源根**（那条照搬 PixCall 的接管链在这里是错的：Eagle 的库是数据库不是图库，
 *    切过去之后网格退化成 `<ID>.info` 文件夹塞着两张图——实测 49 条目 = 49 个文件夹 / 每图三张
 *    缩略图，验收人判定「完全没办法看」）。资源根永远由用户自己选，Eagle 只向它里面添文件；
 * 2. **往用户盘上写东西之前必须先给一眼账**：多少个条目、搬运量多大、能不能硬链接（Q1），
 *    所以是 probe → 预览 → 点确认 → 搬运，而不是点了直接开搬。
 *
 * 合并且仍旧是纯增量的（并集 / 仅为空时填 / 同名不新建 / position 续排），重跑安全；搬运那一步
 * 也是幂等的（目标位置已有同尺寸文件就跳过），中断后再跑一次即可补齐。
 *
 * 报告展示**直接复用** PixcallReportView（吃的是同一份 MigrationReport）：它内部取 `import.*`
 * 的通用键，这里把键前缀换成 `eagle.*` 再交给它——薄包装，报告组件一行不改；Eagle 专属措辞
 * （条目/智能文件夹/品牌名）落在 eagle 命名空间的同位键上。
 */

interface Props {
  t: (key: string) => string;
  /** 我们当前打开的库根：既是认亲的左值，也是搬运的落地位置（`<它>/<库名>`） */
  currentRoot?: string | null;
  onShowToast?: (msg: string, duration?: number) => void;
  /**
   * 导入**写库成功之后**回调。导入是 Rust 侧直接写 `file_metadata`，不经过前端 state，
   * 不回读一次的话详情页还停在旧值（与 PixCall 同一个坑）。上层传的是同一条
   * 「回读元数据」回调（StoragePanel 的 onPixcallImported，名字历史原因）。
   */
  onImported?: () => void;
}

type Stage = 'idle' | 'probing' | 'confirm' | 'takingOver' | 'importing' | 'done' | 'error';

/** `import_records.report_json` 是历史数据，坏一行不该让整块入口消失（同 PixCall §6.5） */
const parseReport = (json: string): MigrationReport | null => {
  try {
    return JSON.parse(json) as MigrationReport;
  } catch {
    return null;
  }
};

const EagleImportSection: React.FC<Props> = ({ t, currentRoot, onShowToast, onImported }) => {
  const [libraries, setLibraries] = useState<EagleLibrary[]>([]);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  /** Rust 侧发来的进度阶段（`takeover` / `probe` / `import`）——搬运与写标注是同一次调用里的两拍 */
  const [progressPhase, setProgressPhase] = useState<string | null>(null);
  const [preview, setPreview] = useState<EaglePreview | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRecord, setLastRecord] = useState<ImportRecord | null>(null);
  const [showLastReport, setShowLastReport] = useState(false);
  /** Q1：默认硬链接（零额外空间）；用户想要独立副本就关掉它 */
  const [preferLink, setPreferLink] = useState(true);
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

  const targetFor = (root: string) => takeoverTargetFor(currentRoot, root);

  /** probe（只读）→ 出预览。这一步本身零写入，只把将要搬什么、搬多少算给人看 */
  const probeLibrary = useCallback(
    async (library: EagleLibrary) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setActiveRoot(library.root);
      setError(null);
      setReport(null);
      setPreview(null);
      try {
        setStage('probing');
        const target = targetFor(library.root);
        if (!target) {
          setStage('error');
          setError(t('eagle.takeoverNoRoot'));
          return;
        }
        const result = await eagleProbe(library.root, target, preferLink);
        setPreview(result);
        setStage('confirm');
      } catch (e) {
        setStage('error');
        setError(String(e));
      } finally {
        setProgress(null);
        busyRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentRoot, preferLink, t]
  );

  /** 确认之后才真正动手：搬运 → 索引 → 认亲 → 写标注 */
  const runImport = useCallback(
    async (library: EagleLibrary, target: string) => {
      busyRef.current = true;
      setError(null);
      setReport(null);
      try {
        setStage('takingOver');
        const result = await eagleImport(library.root, target, preferLink);
        setReport(result);
        setStage('done');
        setLastRecord(await eagleImportRecords().then(rows => (rows.length > 0 ? rows[0] : null)));
        // 库已经写完了，把内存里的 files 拉回一致（否则详情页看到的还是导入前的值）
        onImported?.();
        onShowToast?.(t('eagle.doneToast'));
      } catch (e) {
        setStage('error');
        setError(String(e));
      } finally {
        setProgress(null);
        busyRef.current = false;
      }
    },
    [onImported, onShowToast, preferLink, t]
  );

  if (libraries.length === 0) return null;

  const busy = stage === 'probing' || stage === 'takingOver' || stage === 'importing';
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
  const activeLibrary = libraries.find(lib => lib.root === activeRoot) ?? null;
  const target = activeLibrary ? targetFor(activeLibrary.root) : null;
  const take = preview?.takeover ?? null;
  const incoming = take ? take.toLink + take.toCopy : 0;

  const stageLabel =
    stage === 'probing'
      ? t('eagle.probing')
      : stage === 'takingOver' && progressPhase === 'import'
        ? t('eagle.importing')
        : t('eagle.takingOver');

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

          {!currentRoot && (
            <div className="mb-2.5 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              {t('eagle.takeoverNoRoot')}
            </div>
          )}

          {/* 点一行先看账（probe），不直接动手 */}
          <div className="space-y-1.5">
            {libraries.map(lib => (
              <EagleLibraryRow
                key={lib.root}
                root={lib.root}
                isCurrent={lib.isCurrent}
                onClick={() => void probeLibrary(lib)}
                busy={busy && activeRoot === lib.root}
                disabled={busy || !currentRoot}
                sourceIcon
                t={t}
              />
            ))}
          </div>

          {busy && (
            <div className="mt-4">
              <PixcallProgress label={stageLabel} percent={percent} />
            </div>
          )}

          {/* 事前确认：往用户盘上写东西之前必须给它一眼（Q1/Q2） */}
          {stage === 'confirm' && preview && activeLibrary && target && (
            <div data-testid="eagle-takeover-confirm" className="mt-4 rounded-lg bg-white p-3.5 dark:bg-black/20">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-gray-500 dark:text-gray-400">
                <FolderInput size={13} />
                {t('eagle.takeoverTarget')}
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-gray-700 dark:text-gray-200">{target}</div>

              {take && incoming > 0 ? (
                <>
                  <div className="mt-2 text-[11px] text-gray-600 dark:text-gray-300">
                    {fillTemplate(t('eagle.takeoverSummary'), {
                      total: take.totalItems,
                      already: take.alreadyHere,
                      incoming,
                      size: formatImportBytes(take.bytes),
                    })}
                  </div>
                  <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                    {take.linkSupported ? t('eagle.takeoverLinkMode') : t('eagle.takeoverCopyMode')}
                  </div>
                </>
              ) : (
                <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
                  {t('eagle.takeoverNothing')}
                </div>
              )}

              <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[11px] text-gray-600 select-none dark:text-gray-300">
                <input
                  type="checkbox"
                  data-testid="eagle-prefer-copy"
                  checked={!preferLink}
                  onChange={e => setPreferLink(!e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
                />
                <span className="min-w-0">{t('eagle.takeoverAlwaysCopy')}</span>
              </label>

              {take && take.warnings.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {take.warnings.slice(0, 3).map((warning, index) => (
                    <li key={`${index}-${warning}`} className="text-[11px] text-amber-700 dark:text-amber-300">
                      {warning}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  data-testid="eagle-takeover-start"
                  onClick={() => void runImport(activeLibrary, target)}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-bold text-white transition-colors hover:bg-blue-700"
                >
                  {t('eagle.takeoverStart')}
                </button>
                <button
                  type="button"
                  data-testid="eagle-takeover-cancel"
                  onClick={() => setStage('idle')}
                  className="rounded-lg px-2 py-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200"
                >
                  {t('eagle.takeoverCancel')}
                </button>
              </div>
            </div>
          )}

          {stage === 'error' && error && (
            <div className="mt-4 flex items-start gap-1.5 rounded-lg bg-white px-3 py-2.5 text-xs text-red-600 dark:bg-black/20 dark:text-red-400">
              <AlertCircle size={13} />
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
                {showLastReport ? (
                  <ChevronUp size={12} />
                ) : (
                  <ChevronDown size={12} />
                )}
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
    </div>
  );
};

export default EagleImportSection;
