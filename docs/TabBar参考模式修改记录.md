# TabBar 组件参考模式修改记录

## 会话日期
2026-02-10

## 需求概述
在参考模式下优化 TabBar 组件的显示和行为：
1. 只显示当前画布标签页，隐藏其他标签页
2. 隐藏关闭按钮和新建标签页按钮
3. "始终在前"按钮状态与参考模式同步
4. 修复参考模式下 TabBar 呼出后无法拖动窗口的问题（待解决）

## 已完成的修改

### 1. 添加 "始终在前" 状态同步
在 `useEffect` 中添加了对 `isReferenceMode` 的监听，当进入/退出参考模式时自动同步 "始终在前" 按钮状态：

```typescript
// Sync always on top state with reference mode
useEffect(() => {
  setIsAlwaysOnTop(isReferenceMode);
}, [isReferenceMode]);
```

### 2. 参考模式下只显示当前标签页
修改了标签页渲染逻辑，在参考模式下只渲染当前激活的标签页：

```tsx
{/* In reference mode, only show the active tab */}
{isReferenceMode ? (
  // Reference mode: show only active tab without close button
  // Wrap in a no-drag container to allow dragging on the empty space around the tab
  (() => {
    const activeTab = tabs.find(tab => tab.id === activeTabId);
    if (!activeTab) return null;
    return (
      <div className="flex items-end h-full pt-2 px-2 gap-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <div
          key={activeTab.id}
          className="group relative flex items-center min-w-[80px] max-w-[160px] h-9 px-4 rounded-t-lg text-xs cursor-default select-none transition-all duration-200 bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 font-bold shadow-[0_-2px_10px_rgba(0,0,0,0.05)] z-10 -mb-px"
          title={getTabTitle(activeTab)}
        >
          {getTabIcon(activeTab)}
          <span className="truncate flex-1">{getTabTitle(activeTab)}</span>
        </div>
      </div>
    );
  })()
) : (
  // Normal mode: show all tabs with close buttons and new tab button
  <>
    {tabs.map((tab) => (
      // ... 正常模式下的标签页渲染
    ))}
    <button onClick={onNewTab}>...</button>
  </>
)}
```

### 3. 调整 WebkitAppRegion 设置
尝试修复窗口拖动问题，将 `WebkitAppRegion: 'drag'` 移到外层容器：

```tsx
return (
  <div
    className={`flex flex-col z-[200] transition-transform duration-200 ease-out ...`}
    onMouseEnter={handleMouseEnter}
    onMouseLeave={handleMouseLeave}
    style={{ WebkitAppRegion: 'drag' } as any}  // 移到外层容器
  >
    {/* Hover detection area */}
    {isReferenceMode && !isHoveringTabBar && (
      <div
        className="absolute -bottom-4 left-0 right-0 h-4 cursor-pointer"
        onMouseEnter={handleMouseEnter}
        style={{ WebkitAppRegion: 'no-drag' } as any}
      />
    )}
    <div
      className="flex items-center bg-gray-200 dark:bg-gray-900 border-b border-gray-300 dark:border-gray-800 h-[41px] select-none w-full"
      // WebkitAppRegion 已移到外层
    >
```

## 已知问题

### 参考模式下 TabBar 呼出后无法拖动窗口
**现象**: 
- 鼠标悬停呼出 TabBar 后，无法通过拖动 TabBar 空白处移动窗口
- 点击 TabBar 内的按钮（如"始终在前"、"最大化"）后，可以暂时拖动窗口
- 释放鼠标后，又无法拖动

**可能原因**:
1. `transform` (translate-y) 动画可能影响 `WebkitAppRegion` 的行为
2. 参考模式下 TabBar 使用 `absolute` 定位，可能与拖动区域计算有关
3. 需要点击按钮"激活"后才能拖动，可能是某些状态未正确初始化

**尝试过的解决方案**:
1. 将标签页包裹在 `no-drag` 容器内 - 无效
2. 将 `WebkitAppRegion: 'drag'` 移到外层容器 - 无效

**下一步建议**:
1. 考虑使用 Tauri API 的 `startDragging` 方法手动处理拖动
2. 检查是否有 CSS 属性（如 `pointer-events`）影响了拖动区域
3. 尝试在参考模式下不使用 `transform` 动画，改用 `opacity` 或 `display`

## 文件修改位置
- `src/components/TabBar.tsx` - 主要修改文件

## 相关代码片段

### 悬停检测与显示控制
```tsx
const shouldShowTabBar = !isReferenceMode || isHoveringTabBar;

return (
  <div
    className={`flex flex-col z-[200] transition-transform duration-200 ease-out ${
      isReferenceMode ? 'absolute top-0 left-0 right-0' : 'relative'
    } ${
      shouldShowTabBar ? 'translate-y-0' : '-translate-y-full'
    }`}
    // ...
  >
```

### 始终在前按钮
```tsx
<button
  onClick={handleAlwaysOnTop}
  className={`p-2 rounded transition-all duration-200 ${
    isAlwaysOnTop
      ? 'text-gray-700 bg-gray-400/50 dark:text-gray-200 dark:bg-gray-700/50'
      : 'text-gray-500 hover:bg-gray-300 dark:hover:bg-gray-800'
  }`}
  title={t('window.alwaysOnTop')}
>
  <Pin size={14} className={`transition-transform duration-200 ${isAlwaysOnTop ? 'rotate-45 fill-blue-500 text-blue-500' : ''}`} />
</button>
```
