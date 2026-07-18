# 安卓端屏蔽标签页功能

## 摘要

安卓端使用高性能原生图片查看器（NativeGalleryView）覆盖在 Tauri WebView 之上，导致标签页（TabBar）UI 无法显示；且标签页切换在移动端效率有限。需要在安卓端屏蔽标签页 UI 与相关入口，但保留单 tab 数据结构（避免影响其他逻辑）。比较模式保留，但限制为单个画布（打开新画布时替换现有画布）。PC 端完全保持不变。

## 当前状态分析

### 标签页功能实现位置
- **TabBar 组件**：[src/components/TabBar.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx) — 标签栏 UI，包含标签切换、关闭、新建按钮
- **导航逻辑**：[src/hooks/useNavigation.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/hooks/useNavigation.ts) — `handleNewTab` / `handleCloseTab` / `handleSwitchTab` / `handleOpenCompareInNewTab`
- **快捷键**：[src/hooks/useKeyboardShortcuts.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/hooks/useKeyboardShortcuts.ts) — Ctrl+Tab / Ctrl+W / Ctrl+T（参考模式下已禁用，但未针对安卓屏蔽）
- **右键菜单**：[src/components/ContextMenu.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/ContextMenu.tsx) — 包含「在新标签页打开」「关闭此标签页」等菜单项
- **App.tsx 渲染**：[src/App.tsx#L2910](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2910) — `<TabBar />` 渲染入口
- **App.tsx 比较模式入口**：[src/App.tsx#L1112-L1117](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L1112-L1117) — `handleOpenCompareAndClearSelection` 调用 `handleOpenCompareInNewTab`

### 平台识别工具
- [src/utils/androidPlatform.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/androidPlatform.ts) — `isAndroidSync()` 同步判断
- `isAndroidPlatformCached()` 从 `./api/tauri-bridge` 导入（[App.tsx#L29](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L29)），App.tsx 中已广泛使用

### 已有安卓屏蔽模式（参考）
- TabBar.tsx 中 `isAndroidSync()` 控制窗口控制按钮隐藏（[L55-57](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx#L55-L57)）、全屏模式下完全隐藏（[L328-333](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx#L328-L333)）
- ContextMenu.tsx 已导入 `isAndroidSync`（[L11](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/ContextMenu.tsx#L11)）
- TopBar.tsx 多处使用 `{!isAndroid && ...}` 模式屏蔽 UI

## 提议的修改

### 1. App.tsx — 隐藏 TabBar 渲染

**文件**：[src/App.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx)
**位置**：L2910 `<TabBar ... />` 渲染处
**修改**：用 `{!isAndroidPlatformCached() && (<TabBar ... />)}` 包裹，安卓端不渲染整个 TabBar。
**理由**：TabBar 上有原生查看器覆盖，且标签页切换在移动端无效率。PC 端不变。
**注意**：保留 `handleSwitchTab`、`handleCloseTab`、`handleNewTab`、`handleOpenCompareInNewTab` 等函数不动，PC 端仍可用；安卓端通过其他路径仍可调用 `handleCloseTab`（如 ImageComparer 关闭画布）。

### 2. App.tsx — 比较模式限制为单个画布

**文件**：[src/App.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx)
**位置**：L1112-L1117 `handleOpenCompareAndClearSelection` 函数
**修改**：在调用 `handleOpenCompareInNewTab(imageIds)` 之前，如果是安卓端，先关闭所有现有的 `isCompareMode` tab。
**实现思路**：
```ts
const handleOpenCompareAndClearSelection = useCallback((imageIds: string[]) => {
  // 安卓端：限制为单个画布，先关闭所有现有比较模式 tab
  if (isAndroidPlatformCached()) {
    setState(prev => {
      const newTabs = prev.tabs.filter(t => !t.isCompareMode);
      // 若过滤后无 tab（异常情况），保留原 tabs 不动
      if (newTabs.length === 0) return prev;
      return { ...prev, tabs: newTabs };
    });
  }
  handleOpenCompareInNewTab(imageIds);
  if (isAndroidSelectionMode) {
    setIsAndroidSelectionMode(false);
  }
}, [handleOpenCompareInNewTab, isAndroidSelectionMode, setState]);
```
**理由**：用户选择「限制为单个画布」。打开新画布时自动关闭旧画布，避免无 UI 切换导致的画布堆积。PC 端逻辑完全不变。

### 3. ContextMenu.tsx — 隐藏标签页相关菜单项

**文件**：[src/components/ContextMenu.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/ContextMenu.tsx)
**位置 1**：L245-L250 —「在新标签页打开」/「在新标签页打开文件夹」菜单项
**修改**：增加 `!isAndroidSync()` 条件，安卓端不渲染此菜单项。原条件：
```tsx
{contextMenu.type !== 'file-multi' && contextMenu.type !== 'folder-multi' && (
  <div ... onClick={() => { handleOpenInNewTab(contextMenu.targetId!); ... }}>
    ... {contextMenu.type === 'folder-single' ? t('context.openFolderInNewTab') : t('context.openInNewTab')}
  </div>
)}
```
改为：
```tsx
{!isAndroidSync() && contextMenu.type !== 'file-multi' && contextMenu.type !== 'folder-multi' && (
  ...
)}
```

**位置 2**：L568 — 标签页右键菜单（关闭此标签页 / 关闭其他标签页 / 关闭所有标签页）
**修改**：增加 `!isAndroidSync()` 条件。原条件：
```tsx
{contextMenu.type === 'tab' && contextMenu.targetId && (<> ... </>)}
```
改为：
```tsx
{!isAndroidSync() && contextMenu.type === 'tab' && contextMenu.targetId && (<> ... </>)}
```
**理由**：TabBar 隐藏后标签页右键菜单本身无法触发，但保险起见显式屏蔽。PC 端不变。

### 4. 不修改的部分（保持现状）

- **useKeyboardShortcuts.ts**：用户明确要求不动快捷键逻辑（PC 端不变；安卓端外接键盘场景下快捷键仍可触发，但因无 TabBar UI 新建的 tab 不可见，属于用户接受的边缘情况）
- **useNavigation.ts**：`handleNewTab` / `handleCloseTab` / `handleSwitchTab` / `handleOpenCompareInNewTab` 函数保留原实现，PC 端仍可正常使用
- **TabBar.tsx**：组件本身不修改（App.tsx 中不渲染即可）
- **useAppInit.ts**：安卓端初始化时仍创建 1 个 default tab（保持单 tab 数据结构，避免影响其他逻辑）

## 假设与决策

### 假设
1. 安卓端 `isAndroidPlatformCached()` 与 `isAndroidSync()` 在渲染时返回一致的值（项目已广泛使用两者，且 [androidPlatform.ts#L28-29](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/androidPlatform.ts#L28-L29) 中 `isAndroidPlatform` 异步获取后会同步缓存到 `isAndroidSync`）
2. 安卓端比较模式（ImageComparer）不依赖 TabBar UI 即可工作（ImageComparer 在 [App.tsx#L2976-L3012](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2976-L3012) 中独立渲染，根据 `tab.id === state.activeTabId` 控制显隐）
3. 安卓端单 tab 数据结构（初始化时只创建 1 个 default tab）已能满足浏览需求，无需新增"新建标签页"路径

### 决策
- **方案选择**：隐藏 UI 而非删除数据结构 — 改动最小、风险最低
- **比较模式策略**：限制为单个画布（用户明确选择），通过打开新画布前关闭旧画布实现
- **快捷键**：保持现状（用户明确要求）
- **平台判断函数**：App.tsx 中沿用 `isAndroidPlatformCached()`（与 App.tsx 现有用法一致），ContextMenu.tsx 中沿用 `isAndroidSync()`（已导入且组件内已使用）

## 验证步骤

### PC 端验证（应完全无变化）
1. 启动 PC 端应用，确认 TabBar 正常显示
2. 点击「+」按钮可新建标签页
3. 右键文件 → 显示「在新标签页打开」
4. 右键文件夹 → 显示「在新标签页打开文件夹」
5. 右键标签页 → 显示「关闭此标签页 / 关闭其他标签页 / 关闭所有标签页」
6. 多选图片 → 比较模式 → 可打开多个画布，通过 TabBar 切换
7. Ctrl+T / Ctrl+W / Ctrl+Tab 快捷键正常工作

### 安卓端验证
1. 启动安卓应用，确认顶部无 TabBar 显示
2. 长按文件 → 右键菜单中无「在新标签页打开」
3. 长按文件夹 → 右键菜单中无「在新标签页打开文件夹」
4. 多选图片 → 点击比较 → 进入比较模式（画布01）
5. 退出比较模式 → 再次多选图片 → 点击比较 → 进入新的比较模式（应为新画布，旧画布已被自动关闭）
6. 比较模式中关闭画布 → 正常返回浏览器视图（不依赖 TabBar）
7. 浏览图片 → 原生查看器正常打开（不受 TabBar 隐藏影响）
8. 验证无 TabBar 时侧边栏、TopBar、内容区布局正常（TabBar 原占位空间应被内容区填补）

### 回归测试
1. PC 端标签页所有功能（新建、关闭、切换、右键菜单、快捷键）正常
2. PC 端比较模式多画布切换正常
3. 安卓端比较模式单画布工作正常
4. 安卓端原生查看器、幻灯片、抽屉手势等功能不受影响
