/**
 * 编辑器 Tab 壳:生命周期(打开/关闭引擎文档)+ 布局。
 * 顶部信息栏(撤销/重做/文件名/缩放 + 左右侧面板切换) + 横置工具栏 + 画布;
 * 四组面板渲染在应用右侧面板槽位(RightPanel → EditorRightPanels)。
 */
import React, { useEffect, useState } from 'react';
import { Undo2, Redo2, PanelLeft, PanelRight } from 'lucide-react';
import { editorOpen, editorState } from './editorBridge';
import { disposeSession, ensureSession, getSession, runCommand, subscribeSession, updateSession } from './editorStore';
import { EditorToolbar } from './EditorToolbar';
import { EditorCanvas } from './EditorCanvas';
import { actualPixelsSession, fitSession, zoomSession } from './editorViewActions';
import { ZOOM_STEP } from './viewMath';

export const EditorShell: React.FC<{
  tabId: string;
  fileId: string;
  filePath: string;
  isActive: boolean;
  /** 左侧文件夹栏/右侧面板可见性(应用全局布局态,与主界面 topbar 同源)。 */
  sidebarVisible: boolean;
  metadataVisible: boolean;
  onToggleSidebar: () => void;
  onToggleMetadata: () => void;
}> = ({ tabId, fileId, filePath, isActive, sidebarVisible, metadataVisible, onToggleSidebar, onToggleMetadata }) => {
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
    <div className="w-full h-full flex flex-col bg-[#1e1e1e] text-neutral-200 select-none">
      {/* 顶部信息栏:文件信息 + 撤销重做 + 缩放;右端为左右面板切换(位置对应主界面 topbar) */}
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
        <span className="ml-2 text-neutral-500 truncate max-w-[280px]" title={s?.state?.name ?? filePath}>{s?.state?.name ?? '…'}</span>
        <div className="flex-1" />
        <button onClick={() => zoomSession(tabId, 1 / ZOOM_STEP)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="缩小">−</button>
        <button onClick={() => fitSession(tabId)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="适合屏幕">适应</button>
        <button onClick={() => actualPixelsSession(tabId)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="100%">100%</button>
        <button onClick={() => zoomSession(tabId, ZOOM_STEP)} className="px-1.5 text-neutral-400 hover:text-neutral-100" title="放大">+</button>
        <div className="w-px h-4 bg-neutral-700 mx-1.5" />
        <button
          title={sidebarVisible ? '隐藏左侧面板' : '显示左侧面板'}
          onClick={onToggleSidebar}
          className={`p-1.5 rounded ${sidebarVisible ? 'text-sky-400 hover:bg-neutral-700/60' : 'text-neutral-500 hover:bg-neutral-700/60 hover:text-neutral-300'}`}
        >
          <PanelLeft size={15} />
        </button>
        <button
          title={metadataVisible ? '隐藏右侧面板' : '显示右侧面板'}
          onClick={onToggleMetadata}
          className={`p-1.5 rounded ${metadataVisible ? 'text-sky-400 hover:bg-neutral-700/60' : 'text-neutral-500 hover:bg-neutral-700/60 hover:text-neutral-300'}`}
        >
          <PanelRight size={15} />
        </button>
      </div>
      {/* 横置工具栏(信息栏之下) */}
      <EditorToolbar tabId={tabId} />
      {/* 画布 */}
      <EditorCanvas tabId={tabId} isActive={isActive} />
    </div>
  );
};
