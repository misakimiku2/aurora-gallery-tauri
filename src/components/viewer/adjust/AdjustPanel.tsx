import React, { useState } from 'react';
import {
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  RotateCw,
  Sparkles,
  Undo2,
  Redo2,
  ChevronDown,
  Download,
  Loader2,
  Save,
} from 'lucide-react';
import { AdjustParams, isDefaultAdjustParams, fitCropToAspect } from '../../../utils/adjust';
import { ImageAdjustApi } from '../../../hooks/useImageAdjust';

export interface AdjustPanelProps {
  t: (key: string) => string;
  adjust: ImageAdjustApi;
  /** 裁剪交互态(与 AdjustCanvas 的 showCropUI 联动) */
  cropMode: boolean;
  onCropModeChange: (on: boolean) => void;
  cropAspect: number | null;
  onCropAspectChange: (aspect: number | null) => void;
  /** 导出中状态(由查看器持有) */
  exporting: boolean;
  /** 另存为:产 -edited 新文件 */
  onSaveAs: () => void;
  /** 覆盖原图:仅 JPG/PNG 源可用(查看器按扩展名判定) */
  canOverwrite: boolean;
  onOverwrite: () => void;
  onAutoEnhance: () => void;
}

const TONE_KEYS: Array<{ key: keyof AdjustParams['tone']; labelKey: string }> = [
  { key: 'brightness', labelKey: 'adjust.brightness' },
  { key: 'contrast', labelKey: 'adjust.contrast' },
  { key: 'saturation', labelKey: 'adjust.saturation' },
  { key: 'temperature', labelKey: 'adjust.temperature' },
  { key: 'tint', labelKey: 'adjust.tint' },
];

const ASPECT_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
];

const sliderCls = 'flex-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer';
const iconBtn = 'p-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors';
const iconBtnActive = 'p-1.5 rounded-md bg-blue-500 text-white transition-colors';

/**
 * 调整面板(2026-11-13 §7 修订:集成进右侧面板,不再浮窗)。
 * 由 ImageViewer 经 Portal 注入 MetadataPanel 的 `#aurora-adjust-slot` 插槽
 * ("打开所在文件夹"按钮以下区域),随右栏自然滚动。
 * 滑杆拖动直接改参数对象(预览经 AdjustCanvas 实时生效),持久化/撤销由 useImageAdjust 负责。
 */
export const AdjustPanel: React.FC<AdjustPanelProps> = ({
  t,
  adjust,
  cropMode,
  onCropModeChange,
  cropAspect,
  onCropAspectChange,
  exporting,
  onSaveAs,
  canOverwrite,
  onOverwrite,
  onAutoEnhance,
}) => {
  const { params } = adjust;
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  // 无调整不可另存/覆盖(2026-11-13 用户拍板);撤销回默认也会重新置灰
  const hasChanges = !isDefaultAdjustParams(params);

  const toggleCrop = (): void => {
    if (cropMode) {
      onCropModeChange(false);
    } else {
      onCropModeChange(true);
      if (!params.geo.cropNorm) {
        // 进裁剪态先给一个居中 80% 的框
        adjust.setCropNorm({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
      }
    }
  };

  const pickAspect = (value: number | null): void => {
    onCropAspectChange(value);
    const crop = params.geo.cropNorm;
    if (value && crop) {
      adjust.setCropNorm(fitCropToAspect(crop, value));
    }
  };

  const clearCrop = (): void => {
    adjust.setCropNorm(null);
    onCropModeChange(false);
  };

  return (
    <div
      className="flex flex-col flex-1 min-h-0"
      // ⚠️ mousedown/pointerdown 都要拦:查看器容器的图片拖拽监听的是 mousedown,
      // 只拦 pointerdown 拦不住后续派发的 mousedown(冒泡到容器=拖图,滑杆拖不动)
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 可滚动参数区;动作行钉在面板最底部(2026-11-13 用户拍板)。
          ⚠️ 内层滚动勿用 custom-scrollbar( gutter+负 margin 补偿是面板级专用,
          嵌套会把右侧内容裁掉)——用 index.css 的 .adjust-inner-scroll */}
      <div className="flex-1 min-h-0 adjust-inner-scroll flex flex-col gap-4">
      {/* 标题行(关闭走顶部工具栏的编辑开关/Esc,面板内不放关闭钮) */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('adjust.title')}</span>
        <div className="flex items-center gap-0.5">
          <button onClick={adjust.undo} disabled={!adjust.canUndo} className={`${iconBtn} disabled:opacity-30`} title={t('adjust.undo')}>
            <Undo2 size={14} />
          </button>
          <button onClick={adjust.redo} disabled={!adjust.canRedo} className={`${iconBtn} disabled:opacity-30`} title={t('adjust.redo')}>
            <Redo2 size={14} />
          </button>
        </div>
      </div>

      {/* 几何(五等分铺满面板宽) */}
      <section>
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t('adjust.geometry')}</div>
        <div className="grid grid-cols-5 place-items-center">
          <button onClick={() => adjust.rotateBy(-1)} className={iconBtn} title={t('viewer.rotateLeft')}>
            <RotateCcw size={15} />
          </button>
          <button onClick={() => adjust.rotateBy(1)} className={iconBtn} title={t('viewer.rotateRight')}>
            <RotateCw size={15} />
          </button>
          <button
            onClick={() => adjust.toggleFlip('h')}
            className={params.geo.flipH ? iconBtnActive : iconBtn}
            title={t('adjust.flipH')}
          >
            <FlipHorizontal2 size={15} />
          </button>
          <button
            onClick={() => adjust.toggleFlip('v')}
            className={params.geo.flipV ? iconBtnActive : iconBtn}
            title={t('adjust.flipV')}
          >
            <FlipVertical2 size={15} />
          </button>
          <button
            onClick={toggleCrop}
            className={cropMode ? iconBtnActive : iconBtn}
            title={t('adjust.crop')}
          >
            <Crop size={15} />
          </button>
        </div>

        {/* 拉直 */}
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">{t('adjust.straighten')}</span>
            <span className="text-xs tabular-nums text-gray-400">
              {params.geo.straightenDeg !== 0 ? `${params.geo.straightenDeg.toFixed(1)}°` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={-15}
              max={15}
              step={0.1}
              value={params.geo.straightenDeg}
              onChange={(e) => adjust.setStraighten(parseFloat(e.target.value))}
              onPointerDown={(e) => e.stopPropagation()}
              className={sliderCls}
            />
            <button
              onClick={() => adjust.setStraighten(0)}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 w-6 text-center shrink-0"
              title={t('adjust.resetOne')}
            >
              ×
            </button>
          </div>
        </div>

        {/* 裁剪比例(仅裁剪态显示) */}
        {cropMode && (
          <div className="mt-3 flex items-center gap-1.5 flex-wrap">
            {ASPECT_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => pickAspect(p.value)}
                className={`px-2 py-0.5 text-xs rounded-md transition-colors ${
                  cropAspect === p.value
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {p.value === null ? t('adjust.cropFree') : p.label}
              </button>
            ))}
            <button
              onClick={clearCrop}
              className="px-2 py-0.5 text-xs rounded-md bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              {t('adjust.clearCrop')}
            </button>
          </div>
        )}
      </section>

      {/* 影调 */}
      <section>
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t('adjust.tone')}</div>
        <div className="space-y-2.5">
          {TONE_KEYS.map(({ key, labelKey }) => (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500 dark:text-gray-400">{t(labelKey)}</span>
                <span className="text-xs tabular-nums text-gray-400">
                  {params.tone[key] !== 0 ? params.tone[key].toFixed(2) : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={params.tone[key]}
                  onChange={(e) => adjust.setToneParam(key, parseFloat(e.target.value))}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={sliderCls}
                />
                <button
                  onClick={() => adjust.setToneParam(key, 0)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 w-6 text-center shrink-0"
                  title={t('adjust.resetOne')}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      </div>

      {/* 动作行:钉在右栏最底部;另存为 = 分体按钮(箭头展开"覆盖原图") */}
      <div className="shrink-0 pt-3 relative">
        {saveMenuOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setSaveMenuOpen(false)} />
            {/* 与"另存为"同风格的蓝色按钮;不可用(非 JPG/PNG 源)时整钮置灰(2026-11-13 用户拍板) */}
            <div className="absolute bottom-full left-0 right-0 mb-1 z-30">
              <button
                onClick={() => { setSaveMenuOpen(false); onOverwrite(); }}
                disabled={!canOverwrite || !hasChanges || exporting}
                title={!canOverwrite ? t('adjust.overwriteUnsupported') : undefined}
                className={`w-full h-8 px-3 rounded-lg text-xs font-medium transition-colors ${
                  !canOverwrite
                    ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                    : 'bg-blue-500 hover:bg-blue-600 text-white'
                }`}
              >
                {t('adjust.save')}
              </button>
            </div>
          </>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={onAutoEnhance}
            className="h-8 px-2.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
            title={t('adjust.autoEnhance')}
          >
            <Sparkles size={13} />
            {t('adjust.autoEnhance')}
          </button>
          <div className="flex-1 flex h-8 rounded-lg overflow-hidden">
            <button
              onClick={onSaveAs}
              disabled={!hasChanges || exporting}
              className="flex-1 min-w-0 bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
              title={t('adjust.saveAs')}
            >
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              <span className="truncate">{exporting ? t('adjust.exporting') : t('adjust.saveAs')}</span>
            </button>
            <button
              onClick={() => setSaveMenuOpen((v) => !v)}
              disabled={!hasChanges || exporting}
              className="w-7 shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 border-l border-blue-400/40 text-white flex items-center justify-center transition-colors"
              title={t('adjust.saveOptions')}
            >
              <ChevronDown size={13} className={saveMenuOpen ? 'rotate-180' : ''} />
            </button>
          </div>
          <button
            onClick={adjust.resetAll}
            className="h-8 px-2.5 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
            title={t('adjust.resetAll')}
          >
            <RotateCcw size={13} />
            {t('adjust.resetAll')}
          </button>
        </div>
      </div>
    </div>
  );
};
