/**
 * 新建空白文档对话框（UI 设计 §7.1）。
 *
 * 这是"画布能脱离图"的入口——最小图层模型存在的第二个理由（设计稿 §1）。
 * 预设分三组，顺序即优先级，与 UI 设计 §7.1 一致：
 * 1. 常用画布尺寸（1080p 等）
 * 2. 平台封面预设（YouTube / B 站 / 抖音 / 小红书）——规格清单本身是待拍板项（§八 第 1 条）
 * 3. 自定义
 *
 * **不放体积策略**（标准 / 保留原始分辨率）：那是保存时的事（UI 设计 §7.1）。
 */
import React, { useEffect, useState } from 'react';
import type { EditorCanvas } from '../../types';

interface NewDocumentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (canvas: EditorCanvas) => void;
}

const PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: '1920 × 1080 · 1080p', width: 1920, height: 1080 },
  { label: '1080 × 1080 · 方形', width: 1080, height: 1080 },
  { label: '1280 × 720 · YouTube', width: 1280, height: 720 },
  { label: '1146 × 717 · B 站', width: 1146, height: 717 },
  { label: '1080 × 1920 · 抖音', width: 1080, height: 1920 },
  { label: '1242 × 1660 · 小红书', width: 1242, height: 1660 },
];

const BACKGROUNDS: Array<{ id: EditorCanvas['background']; label: string }> = [
  { id: 'transparent', label: '透明' },
  { id: 'white', label: '白' },
  { id: 'black', label: '黑' },
];

const inputCls =
  'h-7 px-2 rounded text-[12px] tabular-nums border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 w-24';

export const NewDocumentDialog: React.FC<NewDocumentDialogProps> = ({ open, onClose, onCreate }) => {
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [background, setBackground] = useState<EditorCanvas['background']>('transparent');

  // 每次打开复位到默认，避免上次的自定义尺寸成为意外的默认值
  useEffect(() => {
    if (!open) return;
    setWidth(1920);
    setHeight(1080);
    setBackground('transparent');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const clampSize = (v: number) => Math.min(Math.max(Math.round(v) || 1, 1), 20000);
  const submit = () => onCreate({ width: clampSize(width), height: clampSize(height), background });

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        className="w-[22rem] rounded-lg bg-white dark:bg-neutral-800 shadow-xl border border-neutral-200 dark:border-neutral-700"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 text-sm font-medium text-neutral-800 dark:text-neutral-100">
          新建文档
        </div>

        <div className="px-4 py-3 space-y-3">
          <div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1.5">尺寸预设</div>
            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map(p => {
                const active = p.width === width && p.height === height;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setWidth(p.width);
                      setHeight(p.height);
                    }}
                    className={`px-2 h-7 rounded text-[11px] border text-left truncate ${
                      active
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-end gap-2">
            <div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">宽</div>
              <input type="number" value={width} onChange={e => setWidth(Number(e.target.value))} className={inputCls} />
            </div>
            <div>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">高</div>
              <input type="number" value={height} onChange={e => setHeight(Number(e.target.value))} className={inputCls} />
            </div>
          </div>

          <div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">背景</div>
            <div className="flex gap-1.5">
              {BACKGROUNDS.map(b => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setBackground(b.id)}
                  className={`px-3 h-7 rounded text-[11px] border ${
                    background === b.id
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
            建好后是**空画布**，用「导入图层」放图进来。画布尺寸之后还能用裁剪工具改，且不破坏图层内容。
          </p>
        </div>

        <div className="px-4 py-2.5 border-t border-neutral-200 dark:border-neutral-700 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 h-7 rounded text-[12px] border border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            className="px-3 h-7 rounded text-[12px] bg-blue-600 text-white hover:bg-blue-700"
          >
            新建
          </button>
        </div>
      </div>
    </div>
  );
};
