/**
 * 编辑器 Tab 壳:生命周期(打开/关闭引擎文档)+ 布局(主题色随应用浅/深色)。
 * 顶部:文件信息栏(撤销/重做/文件名/缩放) + 工具选项条;
 * 主行:左边缘折叠钮 | 竖置工具栏 | 画布 | 右边缘折叠钮;
 * 四组面板渲染在应用 RightPanel 槽位(RightPanel → EditorRightPanels)。
 */
import React, { useEffect, useState } from 'react';
import { Undo2, Redo2, Save, Sidebar, PanelRight } from 'lucide-react';
import { editorOpen, editorState } from './editorBridge';
import { disposeSession, ensureSession, getSession, runCommand, saveSession, subscribeSession, updateSession } from './editorStore';
import { EditorToolbar } from './EditorToolbar';
import { EditorOptionsBar } from './EditorOptionsBar';
import { EditorCanvas } from './EditorCanvas';
import { actualPixelsSession, fitSession, zoomSession } from './editorViewActions';
import { ZOOM_STEP } from './viewMath';

/** 侧面板切换按钮:样式与主界面 TopBar 完全一致(激活 text-blue-500)。 */
const PanelToggle: React.FC<{ onClick: () => void; active: boolean; title: string; children: React.ReactNode }> = ({
  onClick, active, title, children,
}) => (
  <button
    onClick={onClick}
    title={title}
    className={`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface ${
      active ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'
    }`}
  >
    {children}
  </button>
);

export const EditorShell: React.FC<{
  tabId: string;
  fileId: string;
  filePath: string;
  isActive: boolean;
  /** 左侧文件夹栏/右侧面板可见性(应用全局布局态,与主界面同源)。 */
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
    <div className="w-full h-full flex flex-col bg-content text-neutral-800 dark:text-neutral-200 select-none">
      {/* 文件信息栏(蓝):左端/右端为侧面板切换(样式同主界面 TopBar) */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-1 bg-panel border-b border-black/10 dark:border-white/10 text-[11px]">
        <PanelToggle onClick={onToggleSidebar} active={sidebarVisible} title={sidebarVisible ? '收起文件夹树' : '展开文件夹树'}>
          <Sidebar size={18} />
        </PanelToggle>
        <button
          title="撤销 (Ctrl+Z)"
          disabled={!s?.state?.canUndo}
          onClick={() => void runCommand(tabId, 'edit.undo').catch(console.error)}
          className="p-1.5 text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-900 dark:hover:text-neutral-100 rounded disabled:opacity-30"
        >
          <Undo2 size={15} />
        </button>
        <button
          title="重做 (Ctrl+Shift+Z)"
          disabled={!s?.state?.canRedo}
          onClick={() => void runCommand(tabId, 'edit.redo').catch(console.error)}
          className="p-1.5 text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-900 dark:hover:text-neutral-100 rounded disabled:opacity-30"
        >
          <Redo2 size={15} />
        </button>
        <button
          title="保存 (Ctrl+S) — 覆盖原图 + 同名 .psd 分层伴生"
          onClick={() => void saveSession(tabId).catch((e) => console.error('[editor] 保存失败', e))}
          className="p-1.5 text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 hover:text-neutral-900 dark:hover:text-neutral-100 rounded"
        >
          <Save size={15} />
        </button>
        <span className="ml-2 text-neutral-500 dark:text-neutral-400 truncate max-w-[280px]" title={s?.state?.name ?? filePath}>
          {s?.state?.name ?? '…'}
        </span>
        <div className="flex-1" />
        <button onClick={() => zoomSession(tabId, 1 / ZOOM_STEP)} className="px-1.5 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100" title="缩小">−</button>
        <button onClick={() => fitSession(tabId)} className="px-1.5 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100" title="适合屏幕">适应</button>
        <button onClick={() => actualPixelsSession(tabId)} className="px-1.5 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100" title="实际像素">100%</button>
        <button onClick={() => zoomSession(tabId, ZOOM_STEP)} className="px-1.5 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100" title="放大">+</button>
        <PanelToggle onClick={onToggleMetadata} active={metadataVisible} title={metadataVisible ? '收起右侧面板' : '展开右侧面板'}>
          <PanelRight size={18} />
        </PanelToggle>
      </div>
      {/* 工具选项条(绿):随工具显示对应设置 */}
      <EditorOptionsBar tabId={tabId} />
      {/* 主行:工具栏(黄) | 画布(白);四组面板在应用右栏槽位 */}
      <div className="flex-1 min-h-0 flex">
        <EditorToolbar tabId={tabId} />
        <EditorCanvas tabId={tabId} isActive={isActive} />
      </div>
    </div>
  );
};
