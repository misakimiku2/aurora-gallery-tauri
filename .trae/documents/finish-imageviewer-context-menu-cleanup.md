# 完成 ImageViewer.tsx 上下文菜单清理（收尾计划）

## 背景

本任务是大型 Android 适配代码清理工作的收尾阶段。原计划文件
`.trae/documents/remove-android-adaptations-from-imageviewer.md` 定义了 23 项修改，
其中 Items 1.1–1.20、1.23 已在之前会话中完成。本计划仅处理剩余两项：
- **Item 1.22**：简化上下文菜单（lines 1775–1985）
- **Item 1.23 验证步骤**：最终搜索确认无 `isAndroidPlatformCached`/`isAndroid`/`android` 残留

## 当前状态分析（基于 Phase 1 探索）

### 文件状态
- 路径：`c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src\components\ImageViewer.tsx`
- Imports（lines 1–14）已清理：无 `useCallback`、`usePinchZoom`、`Share2`、`MoreVertical`
- `useLayoutEffect` 仍保留并被 `immersiveFlip`（line 953）使用，需保留
- 已无 `imgNaturalSize`/`containerSize`/`swipeState`/`swipeOffset`/`outgoingUrl`/`nativeViewerActive`/`enterImmersiveOnMount` 残留

### 上下文菜单残留代码（lines 1775–1985）
经 Grep 确认，剩余 20 处 `isAndroid` 引用全部集中在该 IIFE 上下文菜单块内：
- line 1776：`const isAndroid = isAndroidPlatformCached();` 声明
- lines 1777–1787：`menuItemClass`/`menuItemStyle`/`iconSize`/`deleteItemClass`/`purpleItemClass` 的三元
- line 1799：`...(isAndroid ? { fontSize: '15px' } : {})`
- lines 1803、1808、1814、1818、1863、1974、1978：`{!isAndroid && (...)}` 守卫（共 7 处）
- lines 1827、1886、1891、1923、1932：`cls`/`compareCls`/`itemClass`/`subCls` 三元
- lines 1834、1899、1936：`style={isAndroid ? menuItemStyle : undefined}` 等 style 三元（共 3 处）
- 多处 `style={menuItemStyle}` 引用（menuItemStyle PC 值为 `undefined`，应一并删除）

### 注释残留（保留）
- line 111：`// 原因：在 Android WebView 中，response.blob() 对 3-4MB 的 LAN 图片极其缓慢`
  → 属于历史说明性注释，解释 LAN HTTP URL 缓存策略的原因，按任务要求"android（注释除外）"可保留

## 提议变更

### 文件 1：`src/components/ImageViewer.tsx`（lines 1775–1985，唯一修改文件）

**操作**：用 Read 工具读取 lines 1775–1985 的精确内容作为 `old_string`，
用以下简化版作为 `new_string` 进行单次 Edit 替换。

#### 变更要点
1. **移除变量声明**：删除 `const isAndroid = isAndroidPlatformCached();`
2. **删除 `menuItemStyle` 变量**：PC 值本就是 `undefined`，连同所有 `style={menuItemStyle}`、
   `style={isAndroid ? menuItemStyle : undefined}`、`style={canCompare ? menuItemStyle : undefined}`、
   `style={canAdd ? menuItemStyle : undefined}` 引用一并删除
3. **统一类名常量为 PC 值**（均带 `py-2`）：
   - `menuItemClass = 'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center'`
   - `deleteItemClass = 'px-4 py-2 hover:bg-red-600 dark:hover:bg-red-700 hover:text-white text-red-500 dark:text-red-400 cursor-pointer flex items-center'`
   - `purpleItemClass = 'px-4 py-2 hover:bg-purple-600 dark:hover:bg-purple-700 hover:text-white cursor-pointer flex items-center'`
4. **`iconSize = 14`**（PC 值）
5. **移除容器 style 中的 Android 字体**：删除 `...(isAndroid ? { fontSize: '15px' } : {})`，
   style 仅保留 `top`/`left`/`position`/`zIndex`
6. **移除 7 处 `{!isAndroid && (...)}` 守卫**，直接渲染菜单项（原始尺寸、适应窗口、分隔线、
   在资源管理器中显示、复制图片、删除前的分隔线、删除项）
7. **简化内部三元为 PC 值**：
   - `cls`（openFolder 项）→ `'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center'`
   - `compareCls`（对比项可用态）→ `'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center'`
   - `itemClass`（对比项不可用态）→ `'px-4 py-2 flex items-center text-gray-400 cursor-default opacity-60'`
   - `subCls`（子菜单可用态）→ `'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center justify-between'`
   - 子菜单不可用态 → `'px-4 py-2 flex items-center justify-between text-gray-400 cursor-default opacity-60'`

#### 最终代码（替换后的预期形态）
```tsx
{contextMenu.visible && (() => {
  const menuItemClass = 'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center';
  const iconSize = 14;
  const deleteItemClass = 'px-4 py-2 hover:bg-red-600 dark:hover:bg-red-700 hover:text-white text-red-500 dark:text-red-400 cursor-pointer flex items-center';
  const purpleItemClass = 'px-4 py-2 hover:bg-purple-600 dark:hover:bg-purple-700 hover:text-white cursor-pointer flex items-center';
  const closeMenu = () => setContextMenu({ ...contextMenu, visible: false });

  return (
  <div
    data-testid="viewer-context-menu"
    className="fixed bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[220px] z-[60] max-h-[80vh] overflow-y-auto animate-zoom-in"
    style={{
      top: menuPos.top,
      left: menuPos.left,
      position: 'fixed',
      zIndex: 60,
    }}
    onMouseDown={(e) => e.stopPropagation()}
  >
    <div className={menuItemClass} onClick={() => { handleOriginalSize(); closeMenu(); }}>
      <Maximize size={iconSize} className="mr-2 opacity-70" /> {t('viewer.original')}
    </div>
    <div className={menuItemClass} onClick={() => { handleFitWindow(); closeMenu(); }}>
      <Minimize size={iconSize} className="mr-2 opacity-70" /> {t('viewer.fit')}
    </div>

    <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

    <div className={menuItemClass} onClick={() => { onViewInExplorer(file.id); closeMenu(); }}>
      <ExternalLink size={iconSize} className="mr-2 opacity-70" /> {t('context.viewInExplorer')}
    </div>
    {(() => {
      const parentId = file.parentId;
      const isUnavailable = activeTab.viewMode === 'browser' && activeTab.folderId === parentId;
      if (isUnavailable) return null;
      const cls = 'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center';
      return (
        <>
          <div
            className={cls}
            onClick={() => {
              if (parentId) {
                onNavigateToFolder(parentId, { targetId: file.id });
                closeMenu();
              }
            }}
          >
            <FolderOpen size={iconSize} className="mr-2 opacity-70" />
            {t('context.openFolder')}
          </div>
          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>
        </>
      );
    })()}

    <div className={menuItemClass} onClick={() => { onEditTags(); closeMenu(); }}>
      <Tag size={iconSize} className="mr-2 opacity-70" /> {t('context.editTags')}
    </div>

    <div className={menuItemClass} onClick={() => { onCopyTags(); closeMenu(); }}>
      <Tag size={iconSize} className="mr-2 opacity-70" /> {t('context.copyTag')}
    </div>
    <div className={menuItemClass} onClick={() => { onPasteTags(file.id); closeMenu(); }}>
      <Tag size={iconSize} className="mr-2 opacity-70" /> {t('context.pasteTag')}
    </div>

    <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

    <div className={menuItemClass} onClick={() => { handleCopyImage(); closeMenu(); }}>
      <Clipboard size={iconSize} className="mr-2 opacity-70" /> {t('context.copyImage')}
    </div>

    <div className={menuItemClass} onClick={() => { onCopyToFolder(file.id); closeMenu(); }}>
      <Copy size={iconSize} className="mr-2 opacity-70" /> {t('context.copyTo')}
    </div>
    <div className={menuItemClass} onClick={() => { onMoveToFolder(file.id); closeMenu(); }}>
      <Move size={iconSize} className="mr-2 opacity-70" /> {t('context.moveTo')}
    </div>

    <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

    <div className={purpleItemClass} onClick={() => { onAIAnalysis(file.id); closeMenu(); }}>
      <Sliders size={iconSize} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
    </div>

    {/* 图片对比菜单项 - 仅当有图片对比标签页时显示 */}
    {hasCompareTabs && handleOpenCompareInNewTab && handleAddToCompareCanvas && file.type === 'image' && (() => {
      const imageIds = [file.id];
      const canCompare = imageIds.length >= 1 && imageIds.length <= 24;
      const compareCls = 'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center';
      const itemClass = canCompare
        ? compareCls
        : 'px-4 py-2 flex items-center text-gray-400 cursor-default opacity-60';

      return (
        <>
          <div
            className={itemClass}
            onMouseEnter={openCompareSubmenu}
            onMouseLeave={closeCompareSubmenu}
            ref={compareMenuItemRef}
          >
            <Scan size={iconSize} className="mr-2 opacity-70" />
            <div className="flex-1">{t('context.compareImages')}</div>
            <ChevronRight size={iconSize} className="ml-2 opacity-70" />
          </div>
          {/* 二级菜单 - 使用 Portal 渲染到 body 避免被父容器裁剪 */}
          {compareSubmenuOpen && createPortal(
            <div
              className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 min-w-[200px] z-[9999]"
              style={{ left: submenuPosition.x, top: submenuPosition.y }}
              onMouseEnter={openCompareSubmenu}
              onMouseLeave={closeCompareSubmenu}
            >
              {/* 现有画布列表 */}
              {compareTabs.map(tab => {
                const currentCount = tab.selectedFileIds.length;
                const maxCount = 24;
                const remainingSpace = maxCount - currentCount;
                const canAdd = remainingSpace > 0 && imageIds.length <= remainingSpace;
                const canvasName = tab.sessionName || `画布${tab.id.slice(0, 4)}`;
                const subCls = 'px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center justify-between';

                return (
                  <div
                    key={tab.id}
                    className={canAdd
                      ? subCls
                      : 'px-4 py-2 flex items-center justify-between text-gray-400 cursor-default opacity-60'
                    }
                    onClick={canAdd ? () => {
                      handleAddToCompareCanvas(tab.id, imageIds);
                      closeMenu();
                      setCompareSubmenuOpen(false);
                    } : undefined}
                  >
                    <span className="truncate max-w-[120px]">{t('context.addToCanvas').replace('{name}', canvasName)}</span>
                    <span className="text-xs ml-2">{`${currentCount}/${maxCount}`}</span>
                  </div>
                );
              })}
            </div>,
            document.body
          )}
        </>
      );
    })()}

    <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

    <div
      className={menuItemClass}
      onClick={() => { setShowSlideshowSettings(true); closeMenu(); }}
    >
      <Settings size={iconSize} className="mr-2 opacity-70" />
      {t('context.slideshowSettings')}
    </div>
    <div
      className={menuItemClass}
      onClick={toggleSlideshow}
    >
      {slideshowActive ? <Square size={iconSize} className="mr-2" /> : <Play size={iconSize} className="mr-2" />}
      {slideshowActive ? t('context.stopSlideshow') : t('context.startSlideshow')}
    </div>

    <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

    <div className={deleteItemClass} onClick={() => { onDelete(file.id); closeMenu(); }}>
      <Trash2 size={iconSize} className="mr-2 opacity-70" /> {t('context.delete')}
    </div>
  </div>
  );
})()}
```

### 验证步骤（Item 1.23 完成后执行）

1. **Grep 搜索 `isAndroidPlatformCached`**：预期 0 结果
2. **Grep 搜索 `\bisAndroid\b`**：预期 0 结果
3. **Grep 搜索 `android`（不区分大小写）**：预期仅 1 处——line 111 的历史说明性注释
   `// 原因：在 Android WebView 中，response.blob() 对 3-4MB 的 LAN 图片极其缓慢`
   该注释解释 LAN HTTP URL 缓存策略的历史原因，不属于活跃代码，按任务要求"android（注释除外）"保留

## 假设与决策

1. **单次 Edit 替换**：上下文菜单是一个连续的 IIFE 块（lines 1775–1985），
   使用一次 Edit 将整个块替换为简化版，避免多次小 Edit 导致 `old_string` 不唯一问题
2. **`menuItemStyle` 整体删除**：PC 值为 `undefined`，所有 `style={menuItemStyle}` 等同于不传 style，
   直接删除变量和所有引用最简洁
3. **`useLayoutEffect` 保留**：经 Grep 确认仍被 `immersiveFlip`（line 953）使用，不在本次清理范围
4. **line 111 注释保留**：任务明确允许"android（注释除外）"残留，该注释是 LAN 缓存策略的
   历史背景说明，删除会丢失设计决策上下文
5. **不触碰其他文件**：本任务范围仅为 `ImageViewer.tsx`，App.tsx/types.ts/SettingsModal.tsx/
   translations.ts 的修改属于计划文件的"文件 2-5"，不在本次任务范围

## 完成标准

- Edit 替换成功，无错误
- 三项 Grep 验证全部符合预期
- 文件无语法错误（GetDiagnostics 可选验证）
