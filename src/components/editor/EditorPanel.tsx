/**
 * 编辑态右侧面板组（UI 设计 §4，PS 式）。
 *
 * 顺序按用户 2026-10-22 的验收意见重排：**全览图置顶、图层沉底**。
 * 这与 PS 的默认面板栈一致——Navigator 在最上，Layers 在最下，中间是属性类面板。
 *
 * 容器复用现有右面板（`RightPanel` 的 20rem 抽屉），内容在编辑态换成这一套；
 * 浏览态仍是 `MetadataPanel`。**不做选项卡、不做拖拽重排**（UI 设计 §4.2 推荐）。
 *
 * Phase 1 是**骨架**：面板、分组、视觉层级先到位，图层模型与调色还没接引擎。
 * 每个面板都用文字说明哪些控件还没通，不装作可用。
 */
import React, { useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, Eye, Image as ImageIcon, Plus } from 'lucide-react';
import { EditorNavigator } from './EditorNavigator';
import { Adjustments, isZeroAdjustments, ZERO_ADJUSTMENTS } from './colorMatrix';
import { getEditorView, requestPanTo, subscribeEditorView } from './editorViewStore';
import { useEditorThumbnail } from './useEditorThumbnail';

interface EditorPanelProps {
  /** 当前 Tab id：用于订阅该 Tab 的视口状态 */
  tabId: string;
  /** 代理图 data URL */
  previewDataUrl?: string;
  documentName: string;
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  /** 调色参数（-100..100） */
  adjust?: Adjustments;
  onAdjustChange: (next: Adjustments) => void;
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

const Slider: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  onReset: () => void;
}> = ({ label, value, onChange, onReset }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[11px]">
      {/* 双击标签归零：PS 也是这个交互 */}
      <span
        className="text-neutral-500 dark:text-neutral-400 cursor-pointer select-none"
        onDoubleClick={onReset}
        title="双击归零"
      >
        {label}
      </span>
      <span className="tabular-nums text-neutral-700 dark:text-neutral-200 w-8 text-right">
        {value}
      </span>
    </div>
    <input
      type="range"
      min={-100}
      max={100}
      step={1}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="w-full accent-blue-600"
    />
  </div>
);

export const EditorPanel: React.FC<EditorPanelProps> = ({
  tabId,
  previewDataUrl,
  documentName,
  width,
  height,
  previewWidth,
  previewHeight,
  adjust,
  onAdjustChange,
}) => {
  const isProxy = previewWidth !== width || previewHeight !== height;
  const adj = adjust ?? ZERO_ADJUSTMENTS;
  const hasAdjust = !isZeroAdjustments(adj);
  /** 与 ImageEditor 里定义的那个 SVG 滤镜同 id（跨子树引用同一份 filter 定义） */
  const adjustFilter = hasAdjust ? `url(#aurora-editor-adjust-${tabId})` : undefined;

  // 全览图的视口框需要编辑器画布的 scale/x/y —— 从共享 store 拿（rAF 节流）
  const view = useSyncExternalStore(subscribeEditorView, () => getEditorView(tabId));

  // 全览图用较长边的缩略（320 足够 20rem 面板宽度）
  const navigatorThumb = useEditorThumbnail(previewDataUrl, 320);
  // 图层行按 40px 显示，给 96px 源（2x 屏也清晰）；两个尺寸各算一次，
  // 都是逐级减半的高质量降采样，避免用户看到的 64 倍缩小锯齿
  const layerThumb = useEditorThumbnail(previewDataUrl, 96);

  return (
    <div className="h-full flex flex-col overflow-y-auto bg-panel">
      {/* 全览（PS 的 Navigator，置顶） */}
      <Section title="全览">
        <EditorNavigator
          thumb={navigatorThumb}
          imgWidth={previewWidth}
          imgHeight={previewHeight}
          view={view}
          onNavigate={(x, y) => requestPanTo(tabId, x, y)}
          imgFilter={adjustFilter}
        />
      </Section>

      {/* 属性 · 调整 */}
      <Section title="属性 · 调整">
        <Row label="文档" value={documentName.length > 16 ? `${documentName.slice(0, 16)}…` : documentName} />
        <Row label="画布" value={`${width} × ${height}`} />
        {isProxy && <Row label="代理" value={`${previewWidth} × ${previewHeight}`} />}
        <div className="pt-1 space-y-2">
          <Slider
            label="亮度"
            value={adj.brightness}
            onChange={v => onAdjustChange({ ...adj, brightness: v })}
            onReset={() => onAdjustChange({ ...adj, brightness: 0 })}
          />
          <Slider
            label="对比度"
            value={adj.contrast}
            onChange={v => onAdjustChange({ ...adj, contrast: v })}
            onReset={() => onAdjustChange({ ...adj, contrast: 0 })}
          />
          <Slider
            label="饱和度"
            value={adj.saturation}
            onChange={v => onAdjustChange({ ...adj, saturation: v })}
            onReset={() => onAdjustChange({ ...adj, saturation: 0 })}
          />
          <Slider
            label="色温"
            value={adj.temperature}
            onChange={v => onAdjustChange({ ...adj, temperature: v })}
            onReset={() => onAdjustChange({ ...adj, temperature: 0 })}
          />
        </div>
        {hasAdjust && (
          <button
            type="button"
            onClick={() => onAdjustChange(ZERO_ADJUSTMENTS)}
            className="w-full h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            重置全部调整
          </button>
        )}
        <p className="text-[10px] text-neutral-400 dark:text-neutral-500 leading-relaxed">
          实时预览由显卡完成（拖动零延迟）；导出时 Rust 按**同一套颜色矩阵**重算，
          所见即所得。双击滑杆标签可单项归零。
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

      {/* 图层（用户要求沉到最下；与 PS 的默认面板栈一致） */}
      <Section title="图层" hint="1 个">
        <div className="flex items-center gap-2 px-1.5 py-1.5 rounded bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800">
          <Eye size={12} className="text-neutral-500 shrink-0" />
          <div className="w-10 h-10 shrink-0 rounded-sm overflow-hidden bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center">
            {layerThumb ? (
              <img
                src={layerThumb.src}
                alt=""
                className="w-full h-full object-cover"
                style={{ filter: adjustFilter }}
                draggable={false}
              />
            ) : (
              <ImageIcon size={13} className="text-neutral-400" />
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
    </div>
  );
};
