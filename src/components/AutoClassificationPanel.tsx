import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, RefreshCw, AlertCircle, CheckCircle2, X, Wand2, Image as ImageIcon, ArrowRight, Info } from 'lucide-react';
import { ClassifyResult, ClassificationOverview, ClassifyProgress } from '../types';
import {
  classifyContentTypes,
  cancelContentClassification,
  getContentCategoryStats,
  isContentClassifying,
  listenClassifyProgress,
  listenClassifyCompleted,
  listenClassifyCancelled,
} from '../api/tauri-bridge';

interface AutoClassificationPanelProps {
  onClose: () => void;
  onGoToAiVision?: () => void;
}

const categoryLabels: Record<string, string> = {
  landscape: '风景自然',
  people: '人物',
  anime: '动漫插画',
  food: '美食',
  architecture: '建筑',
  animal: '动物',
  screenshot: '截图',
  other: '其他',
  unprocessed: '未分类',
};

export const AutoClassificationPanel: React.FC<AutoClassificationPanelProps> = ({
  onClose,
  onGoToAiVision,
}) => {
  const [isClassifying, setIsClassifying] = useState(false);
  const [progress, setProgress] = useState<ClassifyProgress | null>(null);
  const [result, setResult] = useState<ClassifyResult | null>(null);
  const [overview, setOverview] = useState<ClassificationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [minScore, setMinScore] = useState(1);
  const [showInfo, setShowInfo] = useState(false);
  const unlistenRefs = useRef<Array<() => void>>([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const running = await isContentClassifying();
        if (mounted) setIsClassifying(running);
      } catch { /* ignore */ }
      await refreshStats();
    })();

    Promise.all([
      listenClassifyProgress((p) => { if (mounted) setProgress(p); }),
      listenClassifyCompleted(() => {
        if (mounted) { setIsClassifying(false); setProgress(null); refreshStats(); }
      }),
      listenClassifyCancelled((data) => {
        if (mounted) {
          setIsClassifying(false);
          setProgress(null);
          if (data.reason !== 'user_cancelled') setError(data.reason);
          refreshStats();
        }
      }),
    ]).then((unlistens) => { unlistenRefs.current = unlistens; });

    return () => {
      mounted = false;
      unlistenRefs.current.forEach((u) => u?.());
      unlistenRefs.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshStats = async () => {
    setLoadingStats(true);
    try {
      const o = await getContentCategoryStats();
      setOverview(o);
    } catch { /* ignore */ } finally {
      setLoadingStats(false);
    }
  };

  const handleStart = async () => {
    setError(null);
    setResult(null);
    setProgress({ current: 0, total: 0, progress: 0, stage: 'starting' });
    setIsClassifying(true);
    try {
      const r = await classifyContentTypes(minScore);
      setResult(r);
      await refreshStats();
      window.dispatchEvent(new CustomEvent('topics-data-changed'));
    } catch (e: any) {
      setError(e?.message || String(e));
      setIsClassifying(false);
      setProgress(null);
    }
  };

  const handleCancel = async () => {
    try { await cancelContentClassification(); }
    catch (e: any) { setError(e?.message || String(e)); }
  };

  const goToAiVision = () => {
    onGoToAiVision?.();
    onClose();
  };

  // 数据计算
  const totalIndexed = overview?.totalIndexed ?? 0;
  const totalWithTags = overview?.totalWithTags ?? 0;
  const totalWithoutTags = totalIndexed - totalWithTags;
  const tagCoverage = totalIndexed > 0 ? (totalWithTags / totalIndexed) * 100 : 0;
  const hasNoTags = totalWithTags === 0;
  const lowTagCoverage = tagCoverage > 0 && tagCoverage < 50;

  const categories = overview?.categories ?? [];
  const otherCount = categories.find((s) => s.category === 'other')?.count ?? 0;
  const classifiedTotal = categories
    .filter((s) => s.category !== 'other' && s.category !== 'unprocessed')
    .reduce((sum, s) => sum + s.count, 0);
  const otherRatio = classifiedTotal > 0 ? (otherCount / (classifiedTotal + otherCount)) * 100 : 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-[#262626] rounded-xl shadow-2xl w-[480px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center">
            <Wand2 size={20} className="mr-2.5 text-blue-500" />
            <h3 className="text-lg font-bold text-gray-800 dark:text-white">自动内容分类</h3>
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="ml-2 p-1 text-gray-400 hover:text-blue-500 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
              title="分类说明"
            >
              <Info size={16} />
            </button>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 说明文本弹出层 */}
        {showInfo && (
          <div className="mx-6 mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 text-xs text-gray-600 dark:text-gray-300 space-y-2">
            <div className="flex items-start justify-between mb-1">
              <span className="font-medium text-blue-600 dark:text-blue-400">分类说明</span>
              <button onClick={() => setShowInfo(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <X size={14} />
              </button>
            </div>
            <div>· 自动把图片按内容归入不同类别（风景、人物、动漫、美食等），分类结果会生成专题方便浏览</div>
            <div>· 分类依据是图片已有的<strong>智能标签</strong>（由 WD14 模型生成），不重新跑模型</div>
            <div>· <strong>阈值</strong>：图片至少命中该数量的标签才算归入某类，否则归为「其他」。阈值越高分类越严格但「其他」越多</div>
            <div>· 分类只读取标签数据，不会修改或移动任何图片文件</div>
            <div>· 重复点击「开始分类」会覆盖之前的分类结果</div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* 前置条件检测：无标签引导 */}
          {hasNoTags && !isClassifying && (
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-start">
                <AlertCircle size={18} className="mr-2.5 mt-0.5 text-amber-500 flex-shrink-0" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">
                    还没有智能标签
                  </div>
                  <div className="text-xs text-amber-600 dark:text-amber-500 mb-3">
                    自动分类需要图片先有智能标签。你的图库中有 {totalIndexed} 张图片，但还没有生成任何标签。
                    请先前往「AI视觉」启用模型并生成标签。
                  </div>
                  <button
                    onClick={goToAiVision}
                    className="px-3 py-1.5 bg-amber-500 text-white text-xs font-medium rounded-lg hover:bg-amber-600 transition-colors flex items-center"
                  >
                    前往 AI视觉
                    <ArrowRight size={12} className="ml-1.5" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 标签覆盖率（有标签但覆盖率低） */}
          {!hasNoTags && lowTagCoverage && !isClassifying && (
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 flex items-start">
              <ImageIcon size={16} className="mr-2 mt-0.5 text-blue-500 flex-shrink-0" />
              <div className="text-xs text-blue-600 dark:text-blue-400">
                已有 {totalWithTags} / {totalIndexed} 张图片的标签（{tagCoverage.toFixed(0)}%）。
                未打标签的图片不会参与分类，建议先补全标签再分类。
              </div>
            </div>
          )}

          {/* 数据概览 - 三列卡片 */}
          {totalIndexed > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-700 dark:text-gray-200">{totalIndexed}</div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">图片总数</div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-blue-500">{totalWithTags}</div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">已打标签</div>
              </div>
              {/* 未打标签卡片 - 可点击跳转 */}
              <button
                onClick={totalWithoutTags > 0 ? goToAiVision : undefined}
                disabled={totalWithoutTags === 0}
                className={`bg-gray-50 dark:bg-gray-800/60 rounded-lg p-3 text-center transition-colors ${
                  totalWithoutTags > 0 ? 'hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer' : 'cursor-default'
                }`}
                title={totalWithoutTags > 0 ? '点击前往 AI视觉 生成标签' : undefined}
              >
                <div className={`text-xl font-bold ${totalWithoutTags > 0 ? 'text-amber-500' : 'text-gray-400'}`}>
                  {totalWithoutTags}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 flex items-center justify-center">
                  未打标签
                  {totalWithoutTags > 0 && <ArrowRight size={10} className="ml-0.5 text-amber-400" />}
                </div>
              </button>
            </div>
          )}

          {/* 阈值调节 */}
          <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">分类阈值</span>
              <span className="text-sm font-bold text-blue-500">{minScore}</span>
            </div>
            <input
              type="range"
              min={1}
              max={5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              disabled={isClassifying}
              className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
            />
            <div className="flex justify-between mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
              <span>宽松（命中1个即可）</span>
              <span>严格（命中5个以上）</span>
            </div>
            <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">
              图片至少命中 {minScore} 个某类标签才归入该类，否则归为「其他」
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex items-center space-x-2">
            {isClassifying ? (
              <button
                onClick={handleCancel}
                className="flex-1 px-4 py-2.5 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 rounded-lg text-sm font-medium transition-colors flex items-center justify-center"
              >
                <Square size={14} className="mr-1.5" />
                取消分类
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={hasNoTags}
                className="flex-1 px-4 py-2.5 bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors flex items-center justify-center shadow-sm"
              >
                <Play size={14} className="mr-1.5" />
                {hasNoTags ? '需要先打标签' : '开始分类'}
              </button>
            )}
            <button
              onClick={refreshStats}
              disabled={loadingStats}
              className="p-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-600 dark:text-gray-300 transition-colors"
              title="刷新统计"
            >
              <RefreshCw size={14} className={loadingStats ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* 进度条 */}
          {isClassifying && progress && (
            <div>
              <div className="flex justify-between items-center mb-1.5 text-xs text-gray-500 dark:text-gray-400">
                <span>
                  {progress.stage === 'creating_topics' ? '正在生成专题...' : '正在分类图片...'}
                  {progress.current > 0 && progress.total > 0 && ` ${progress.current} / ${progress.total}`}
                </span>
                <span>{progress.progress}%</span>
              </div>
              <div className="w-full h-2 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
              {progress.classified !== undefined && progress.skipped !== undefined && (
                <div className="flex justify-between mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                  <span>已归类: {progress.classified}</span>
                  <span>未匹配: {progress.skipped}</span>
                </div>
              )}
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="p-3 bg-red-500/10 rounded-lg flex items-start text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={14} className="mr-2 mt-0.5 flex-shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {/* 完成结果 */}
          {result && !isClassifying && (
            <div className="p-3 bg-green-500/10 rounded-lg flex items-start text-xs text-green-600 dark:text-green-400">
              <CheckCircle2 size={14} className="mr-2 mt-0.5 flex-shrink-0" />
              <div>
                <div>分类完成！共处理 {result.total} 张图片，归类 {result.classified} 张。</div>
                <div className="text-[11px] mt-0.5">
                  生成了 {result.topicsCreated} 个专题，可在专题列表中查看（筛选「内容分类」）。
                </div>
              </div>
            </div>
          )}

          {/* other 类过大提示 */}
          {otherRatio > 30 && !isClassifying && classifiedTotal > 0 && (
            <div className="p-3 bg-yellow-500/10 rounded-lg flex items-start text-xs text-yellow-600 dark:text-yellow-400">
              <AlertCircle size={14} className="mr-2 mt-0.5 flex-shrink-0" />
              <span>「其他」类占比 {otherRatio.toFixed(0)}%，说明很多图片的标签未命中现有规则。可尝试降低阈值或后续补充规则文件。</span>
            </div>
          )}

          {/* 分类统计 */}
          {categories.length > 0 && (
            <div>
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">分类统计</div>
              <div className="grid grid-cols-2 gap-2">
                {categories
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .map((s) => {
                    const total = categories.reduce((sum, c) => sum + c.count, 0);
                    const ratio = total > 0 ? (s.count / total) * 100 : 0;
                    const isOther = s.category === 'other';
                    const isUnprocessed = s.category === 'unprocessed';
                    return (
                      <div
                        key={s.category}
                        className="p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50"
                      >
                        <div className="flex justify-between items-center mb-1.5">
                          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                            {categoryLabels[s.category] || s.category}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{s.count}</span>
                        </div>
                        <div className="w-full h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${isOther ? 'bg-gray-400' : isUnprocessed ? 'bg-gray-300 dark:bg-gray-600' : 'bg-blue-500'}`}
                            style={{ width: `${Math.max(ratio, 2)}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{ratio.toFixed(1)}%</div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
