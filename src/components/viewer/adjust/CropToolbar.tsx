import React from 'react';
import { Check, Trash2, X } from 'lucide-react';

const ASPECT_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
];

const chipCls = (active: boolean): string =>
  `px-2 py-1 text-xs rounded-md transition-colors flex items-center ${
    active
      ? 'bg-blue-500 text-white'
      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
  }`;

export interface CropToolbarProps {
  t: (key: string) => string;
  cropAspect: number | null;
  onPickAspect: (aspect: number | null) => void;
  onClear: () => void;
  onApply: () => void;
  onCancel: () => void;
}

/**
 * 裁剪调整栏(2026-11-14 用户口径:裁剪相关选项放在顶部工具栏下方,
 * 进裁剪态时出现,比例预设/清除/应用/取消都在这条栏上,不再挤右栏)。
 * ⚠️ 悬浮覆盖(top-14 紧贴工具栏下沿)而非文档流——否则进裁剪态会把舞台
 * 压低 40px,图片肉眼可见地缩小(2026-11-14 用户口径:点击裁剪时图片
 * 无任何大小变化)。冒烟定位锚点:[data-crop-toolbar]。
 */
export const CropToolbar: React.FC<CropToolbarProps> = ({
  t,
  cropAspect,
  onPickAspect,
  onClear,
  onApply,
  onCancel,
}) => {
  return (
    <div
      data-crop-toolbar="1"
      className="absolute inset-x-0 top-14 h-10 flex items-center gap-1.5 px-4 bg-white dark:bg-[#262626] border-b border-gray-200 dark:border-gray-700 z-30"
      // 与调整面板同口径:mousedown/pointerdown/wheel/click 全拦,不触发画布平移/缩放
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-1">{t('adjust.crop')}</span>
      {ASPECT_PRESETS.map((p) => (
        <button
          key={p.label}
          onClick={() => onPickAspect(p.value)}
          className={chipCls(cropAspect === p.value)}
        >
          {p.value === null ? t('adjust.cropFree') : p.label}
        </button>
      ))}
      <div className="flex-1" />
      <button onClick={onClear} className={chipCls(false)} title={t('adjust.clearCrop')}>
        <Trash2 size={12} className="mr-1" />
        {t('adjust.clearCrop')}
      </button>
      <div className="h-5 w-px bg-gray-300 dark:bg-gray-700 mx-1" />
      <button onClick={onCancel} className={chipCls(false)}>
        <X size={12} className="mr-1" />
        {t('adjust.cancelCrop')}
      </button>
      <button
        onClick={onApply}
        className="px-2.5 py-1 text-xs rounded-md bg-blue-500 text-white hover:bg-blue-600 transition-colors flex items-center"
      >
        <Check size={12} className="mr-1" />
        {t('adjust.applyCrop')}
      </button>
    </div>
  );
};
