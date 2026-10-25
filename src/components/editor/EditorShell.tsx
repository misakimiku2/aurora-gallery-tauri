/**
 * 编辑器 Tab 壳:生命周期(打开/关闭引擎文档)+ PS 式布局
 * 左工具栏 │ 顶部选项条 + 画布 │ 右侧四组面板(颜色/属性·调整·历史/导航器·信息/图层·路径)。
 */
import React, { useEffect, useState } from 'react';
import { Undo2, Redo2 } from 'lucide-react';
import { editorOpen, editorState } from './editorBridge';
import { disposeSession, ensureSession, getSession, runCommand, subscribeSession, updateSession } from './editorStore';
import { EditorToolbar } from './EditorToolbar';
import { EditorCanvas } from './EditorCanvas';
import { ColorPanel } from './panels/ColorPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { NavigatorInfoPanel } from './panels/NavigatorInfoPanel';
import { LayersPanel } from './panels/LayersPanel';
import { actualPixelsSession, fitSession, zoomSession } from './editorViewActions';
import { ZOOM_STEP } from './viewMath';

const MidPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [tab, setTab] = useState<'props' | 'adjust' | 'history'>('history');
  return (
    <div className="flex flex-col min-h-0 flex-1 border-b border-neutral-800">
      <div className="flex shrink-0 border-b border-neutral-800">
        {([['props', '属性'], ['adjust', '调整'], ['history', '历史记录']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-2.5 py-1 text-[11px] ${tab === k ? 'text-neutral-100 border-b-2 border-sky-500' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'history' && <HistoryPanel tabId={tabId} />}
        {tab === 'props' && <div className="p-2 text-[11px] text-neutral-500">文档属性/蒙版属性(M3)</div>}
        {tab === 'adjust' && <div className="p-2 text-[11px] text-neutral-500">16 种调整层(M3)</div>}
      </div>
    </div>
  );
};

export const EditorShell: React.FC<{
  tabId: string;
  fileId: string;
  filePath: string;
  isActive: boolean;
}> = ({ tabId, fileId, filePath, isActive }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);

  // 生命周期:挂载开文档,卸载关会话
  useEffect(() => {
    const s = ensureSession(tabId, fileId);
    if (s.docId != null) return undefined; // 已开(标签隐藏再显示)
    let cancelled = false;
    (async () => {
      try {
        const info = await editorOpen(filePath);
        if (cancelled) return;
        updateSession(tabId, { docId: info.docId, path: filePath, loading: false });
        const st = await editorState(info.docId);
        if (!cancelled) updateSession(tabId, { state: st });
      } catch (e) {
        if (!cancelled) updateSession(tabId, { loading: false, error: `打开失败:${String(e)}` });
      }
    })();
    return () => {
      cancelled = true;
      disposeSession(tabId);
    };
  }, [tabId, fileId, filePath]);

  const s = getSession(tabId);

  return (
    <div className="w-full h-full flex bg-[#1e1e1e] text-neutral-200 select-none">
      <EditorToolbar tabId={tabId} />
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 顶部选项条:M1 为 undo/redo + 缩放;M2 起随工具显示对应选项 */}
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 bg-[#252525] border-b border-neutral-800 text-[11px]">
          <button
            title="撤销 (Ctrl+Z)"
            disabled={!s?.state?.canUndo}
            onClick={() => void runCommand(tabId, 'edit.undo').catch(console.error)}
            className="p-1.5 text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            <Undo2 size={15} />
          </button>
          <button
            title="重做 (Ctrl+Shift+Z)"
            disabled={!s?.state?.canRedo}
            onClick={() => void runCommand(tabId, 'edit.redo').catch(console.error)}
            className="p-1.5 text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            <Redo2 size={15} />
          </button>
          <span className="ml-2 text-neutral-500">{s?.state?.name ?? '…'}</span>
          <div className="flex-1" />
          <button onClick={() => zoomSession(tabId, 1 / ZOOM_STEP)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="缩小">−</button>
          <button onClick={() => fitSession(tabId)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="适合屏幕">适应</button>
          <button onClick={() => actualPixelsSession(tabId)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="100%">100%</button>
          <button onClick={() => zoomSession(tabId, ZOOM_STEP)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="放大">+</button>
        </div>
        <EditorCanvas tabId={tabId} isActive={isActive} />
      </div>
      {/* 右侧四组面板(自上而下,PS 布局) */}
      <div className="w-[240px] shrink-0 flex flex-col bg-[#252525] border-l border-neutral-800 min-h-0">
        <ColorPanel tabId={tabId} />
        <MidPanel tabId={tabId} />
        <NavigatorInfoPanel tabId={tabId} />
        <LayersPanel tabId={tabId} />
      </div>
    </div>
  );
};
