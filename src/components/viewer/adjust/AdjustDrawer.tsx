import React, { useState } from 'react';
import {
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  RotateCw,
  Scan,
  Sparkles,
  Undo2,
  Redo2,
  Download,
  Loader2,
  X,
} from 'lucide-react';
import { AdjustParams, fitCropToAspect } from '../../../utils/adjust';
import { ImageAdjustApi } from '../../../hooks/useImageAdjust';

export interface AdjustDrawerProps {
  t: (key: string) => string;
  adjust: ImageAdjustApi;
  /** 裁剪交互态(与 AdjustCanvas 的 showCropUI 联动) */
  cropMode: boolean;
  onCropModeChange: (on: boolean) => void;
  cropAspect: number | null;
  onCropAspectChange: (aspect: number | null) => void;
  /** 导出中状态(由查看器持有) */
  exporting: boolean;
  onExport: () => void;
  onAutoEnhance: () => void;
  onClose: () => void;
}

const TONE_KEYS: Array<{ key: keyof AdjustParams['tone']; labelKey: string; min: number; max: number }> = [
  { key: 'brightness', labelKey: 'adjust.brightness', min: -1, max: 1 },
  { key: 'contrast', labelKey: 'adjust.contrast', min: -1, max: 1 },
  { key: 'saturation', labelKey: 'adjust.saturation', min: -1, max: 1 },
  { key: 'temperature', labelKey: 'adjust.temperature', min: -1, max: 1 },
  { key: 'tint', labelKey: 'adjust.tint', min: -1, max: 1 },
];

const ASPECT_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
];

/**
 * 调整抽屉(右侧浮层)。滑杆拖动直接改参数对象(预览经 AdjustCanvas 实时生效),
 * 持久化/撤销由 useImageAdjust 负责。导出走 bake_edits(产 -edited 新文件)。
 */
export const AdjustDrawer: React.FC<AdjustDrawerProps> = ({
  t,
  adjust,
  cropMode,
  onCropModeChange,
  cropAspect,
  onCropAspectChange,
  exporting,
  onExport,
  onAutoEnhance,
  onClose,
}) => {
  const { params } = adjust;
  const btn = 'p-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors';
  const btnActive = 'p-1.5 rounded-md bg-blue-500 text-white transition-colors';

  const enableCrop = (): void => {
    onCropModeChange(true);
    if (!params.geo.cropNorm) {
      // 进裁剪态先给一个居中 80% 的框
      adjust.setCropNorm({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    }
  };

  const toggleCrop = (): void => {
    if (cropMode) {
      onCropModeChange(false);
    } else {
      enableCrop();
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
      className="absolute top-3 right-3 bottom-3 w-72 z-[20] rounded-xl bg-white/95 dark:bg-[#1f1f1f]/95 backdrop-blur-sm shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t('adjust.title')}</span>
        <div className="flex items-center gap-0.5">
          <button onClick={adjust.undo} disabled={!adjust.canUndo} className={`${btn} disabled:opacity-30`} title={t('adjust.undo')}>
            <Undo2 size={15} />
          </button>
          <button onClick={adjust.redo} disabled={!adjust.canRedo} className={`${btn} disabled:opacity-30`} title={t('adjust.redo')}>
            <Redo2 size={15} />
          </button>
          <button onClick={onClose} className={btn} title={t('adjust.close')}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
        {/* 几何 */}
        <section>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t('adjust.geometry')}</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={() => adjust.rotateBy(-1)} className={btn} title={t('viewer.rotateLeft')}>
              <RotateCcw size={16} />
            </button>
            <button onClick={() => adjust.rotateBy(1)} className={btn} title={t('viewer.rotateRight')}>
              <RotateCw size={16} />
            </button>
            <button
              onClick={() => adjust.toggleFlip('h')}
              className={params.geo.flipH ? btnActive : btn}
              title={t('adjust.flipH')}
            >
              <FlipHorizontal2 size={16} />
            </button>
            <button
              onClick={() => adjust.toggleFlip('v')}
              className={params.geo.flipV ? btnActive : btn}
              title={t('adjust.flipV')}
            >
              <FlipVertical2 size={16} />
            </button>
            <button
              onClick={toggleCrop}
              className={cropMode ? btnActive : btn}
              title={t('adjust.crop')}
            >
              <Scan size={16} />
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
                className="flex-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
              />
              <button
                onClick={() => adjust.setStraighten(0)}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 w-8 text-center"
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
                    className="flex-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
                  />
                  <button
                    onClick={() => adjust.setToneParam(key, 0)}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 w-8 text-center"
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

      {/* 底部动作 */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center gap-2 shrink-0">
        <button
          onClick={onAutoEnhance}
          className="h-8 px-3 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0"
          title={t('adjust.autoEnhance')}
        >
          <Sparkles size={13} />
          {t('adjust.autoEnhance')}
        </button>
        <button
          onClick={onExport}
          disabled={exporting}
          className="flex-1 h-8 px-3 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:opacity-60 text-white text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
          title={t('adjust.export')}
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {exporting ? t('adjust.exporting') : t('adjust.export')}
        </button>
        <button
          onClick={adjust.resetAll}
          className="h-8 px-3 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 text-xs font-medium flex items-center gap-1.5 transition-colors"
          title={t('adjust.resetAll')}
        >
          <RotateCcw size={13} />
          {t('adjust.resetAll')}
        </button>
      </div>
    </div>
  );
};
