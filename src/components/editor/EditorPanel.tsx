/**
 * 编辑态右侧面板组（UI 设计 §4，PS 式）。
 *
 * 容器复用现有右面板（`RightPanel.tsx` 的 20rem 抽屉），内容在编辑态换成这一套；
 * 浏览态仍是 `MetadataPanel`。**不做选项卡、不做拖拽重排**——首版固定顺序堆叠、
 * 每个面板可折叠即可（UI 设计 §4.2 的推荐）。
 *
 * Phase 1 的定位是**骨架**：面板、分组、视觉层级先到位，里面的图层模型与调色
 * 还没接引擎。所以每个面板都用 `pending` 标注哪些控件还没通，不装作可用。
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Eye, Image as ImageIcon, Plus } from 'lucide-react';

interface EditorPanelProps {
  /** 代理图 data URL，只用于图层缩略图 */
  previewDataUrl?: string;
  documentName: string;
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
}

const Section: React.FC<{
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  hint?: string;
}> = ({ title, defaultOpen = true, children, hint }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-neutral-200 dark:border-neutral-700">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full h-8 flex items-center gap-1 px-3 text-[11px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 select-none"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
        {hint && <span className="ml-auto text-[10px] font-normal text-neutral-400">{hint}</span>}
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between text-[11px]">
    <span className="text-neutral-500 dark:text-neutral-400">{label}</span>
    <span className="tabular-nums text-neutral-700 dark:text-neutral-200">{value}</span>
  </div>
);

const Slider: React.FC<{ label: string }> = ({ label }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-neutral-400 dark:text-neutral-500">{label}</span>
      <span className="tabular-nums text-neutral-400 dark:text-neutral-500">0</span>
    </div>
    <input type="range" min={-100} max={100} defaultValue={0} disabled className="w-full accent-blue-600 opacity-40" />
  </div>
);

export const EditorPanel: React.FC<EditorPanelProps> = ({
  previewDataUrl,
  documentName,
  width,
  height,
  previewWidth,
  previewHeight,
}) => {
  const isProxy = previewWidth !== width || previewHeight !== height;

  return (
    <div className="h-full flex flex-col overflow-y-auto bg-panel">
      {/* 图层 */}
      <Section title="图层" hint="1 个">
        <div className="flex items-center gap-2 px-1.5 py-1 rounded bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800">
          <Eye size={12} className="text-neutral-500 shrink-0" />
          <div className="w-8 h-8 shrink-0 rounded-sm overflow-hidden bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center">
            {previewDataUrl ? (
              <img src={previewDataUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <ImageIcon size={12} className="text-neutral-400" />
            )}
          </div>
          <span className="text-[11px] truncate text-neutral-700 dark:text-neutral-200">背景</span>
        </div>
        <button
          type="button"
          disabled
          className="w-full h-7 flex items-center justify-center gap-1 rounded border border-dashed border-neutral-300 dark:border-neutral-600 text-[11px] text-neutral-400 cursor-not-allowed"
        >
          <Plus size={11} /> 新建图层
        </button>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          多图层、混合模式、不透明度将在 Phase 2 接入；现在是单图文档。
        </p>
      </Section>

      {/* 属性 · 调整 */}
      <Section title="属性 · 调整">
        <Row label="文档" value={documentName.length > 14 ? `${documentName.slice(0, 14)}…` : documentName} />
        <Row label="画布" value={`${width} × ${height}`} />
        {isProxy && <Row label="代理" value={`${previewWidth} × ${previewHeight}`} />}
        <div className="pt-1 space-y-2">
          <Slider label="亮度" />
          <Slider label="对比度" />
          <Slider label="饱和度" />
          <Slider label="色温" />
        </div>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          调色滑杆尚未接入引擎，接入后会走 `core::imaging` 的 transform 段。
        </p>
      </Section>

      {/* 颜色 */}
      <Section title="颜色" defaultOpen={false}>
        <div className="flex items-center gap-2">
          <div className="relative w-8 h-8">
            <div
              className="absolute left-0 top-0 w-6 h-6 rounded-sm border border-neutral-300 dark:border-neutral-500 bg-black"
              title="前景色"
            />
            <div
              className="absolute right-0 bottom-0 w-6 h-6 rounded-sm border border-neutral-300 dark:border-neutral-500 bg-white"
              title="背景色"
            />
          </div>
          <div className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-tight">
            前景 #000000
            <br />
            背景 #FFFFFF
          </div>
        </div>
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500">
          色板与吸管结果在 Phase 2 接入。
        </p>
      </Section>

      {/* 文字（仅选中文字图层时出现，Phase 2） */}
      <Section title="文字" defaultOpen={false} hint="选中文字图层后可用">
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          字体、字号、行距、描边、阴影——随文字工具一起在 Phase 2 接入。
        </p>
      </Section>
    </div>
  );
};
