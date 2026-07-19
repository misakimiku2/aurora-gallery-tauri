# 统一 UI 颜色与移除分隔线

## 摘要

当前 UI 颜色杂乱（bg-gray-50/100/200/800/850/900 混用），分隔线过多。本次改动统一所有界面背景为 `#ffffff`（浅色）/ `#262626`（深色），移除多余分隔线与装饰性字样；同时将深色主题的高亮颜色从 `gray-800`(#1f2937) 提升为 `#3a3a3a`，使其在新背景 `#262626` 上仍能形成可见对比。标签页栏背景保持不变。

## 当前状态分析

### 分隔线分布
| 位置 | 文件:行 | 当前 className 片段 |
|------|---------|---------------------|
| 左侧 Sidebar 右边框 | [App.tsx#L2957](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2957) | `border-r border-gray-200 dark:border-gray-800` |
| 右侧 MetadataPanel 左边框 | [App.tsx#L3575](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3575) | `border-l border-gray-200 dark:border-gray-800` |
| 右侧 ColorPickerPanel 左边框 | [App.tsx#L3608](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3608) | `border-l border-gray-200 dark:border-gray-800` |
| TopBar 底部分隔线 | [TopBar.tsx#L768](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L768) | `border-b border-gray-200 dark:border-gray-800` |
| TabBar 底部分隔线 | [TabBar.tsx#L355](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx#L355) | `border-b border-gray-300 dark:border-gray-800` |
| 面包屑导航底部分隔线 | [App.tsx#L3207](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3207) | `bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800` |
| TreeSidebar "资源目录"标题分隔线 | [TreeSidebar.tsx#L1486](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1486) | `border-b border-gray-200 dark:border-gray-800` |
| TreeSidebar 任务区域顶部分隔线 | [TreeSidebar.tsx#L1611](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1611) | `border-t border-gray-200 dark:border-gray-800` |
| TreeSidebar 设置区域顶部分隔线 | [TreeSidebar.tsx#L1679](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1679) | `border-t border-gray-200 dark:border-gray-800` |
| TreeSidebar 设置按钮顶部分隔线 | [TreeSidebar.tsx#L1721](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1721) | `border-t border-gray-200 dark:border-gray-800` |
| TreeSidebar 底部字样顶部分隔线 | [TreeSidebar.tsx#L1742](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1742) | `border-t border-gray-200 dark:border-gray-800` |

### 背景色分布（当前）
| 组件 | 文件:行 | 当前 className |
|------|---------|----------------|
| 根容器 | [App.tsx#L2889](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2889) | `bg-white dark:bg-gray-900` |
| TabBar（保持不变） | [TabBar.tsx#L355](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx#L355) | `bg-gray-200 dark:bg-gray-900` |
| TopBar | [TopBar.tsx#L768](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L768) | `bg-white dark:bg-gray-900` |
| 左侧 Sidebar 容器 | [App.tsx#L2954](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2954) | `bg-gray-50 dark:bg-gray-850` |
| 右侧 MetadataPanel 容器 | [App.tsx#L3572](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3572) | `bg-gray-50 dark:bg-gray-850` |
| 右侧 ColorPickerPanel 容器 | [App.tsx#L3605](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3605) | `bg-white dark:bg-gray-800` |
| 主内容区 | [App.tsx#L2963](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2963) | `bg-white dark:bg-gray-900` |
| 面包屑导航 | [App.tsx#L3207](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3207) | `bg-gray-50 dark:bg-gray-900` |

### 深色主题高亮颜色（当前 `dark:bg-gray-800` 即 #1f2937）
| 场景 | 文件:行 | 当前 className 片段 |
|------|---------|---------------------|
| 文件/文件夹卡片默认背景 | [FileGrid.tsx#L594](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx#L594) | `bg-gray-100 dark:bg-gray-800` |
| 文件夹分组标题 + hover | [FileGrid.tsx#L845](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx#L845) | `bg-gray-50 dark:bg-gray-900 ... hover:bg-gray-100 dark:hover:bg-gray-800` |
| TopBar 搜索框背景 | [TopBar.tsx#L888](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L888) | `bg-gray-100 dark:bg-gray-800` |
| TopBar 按钮 hover（多处） | [TopBar.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx) L771/774/779/782/785/802/809/1127/1187/1265/1281/1376/1392/1452/1477/1504/1513 等约 17 处 | `hover:bg-gray-100 dark:hover:bg-gray-800` |
| TopBar 激活态按钮背景 | [TopBar.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx) L809/1127/1187/1281/1392 等 | `bg-gray-100 dark:bg-gray-800` |
| TreeSidebar 节点 hover（多处） | [TreeSidebar.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx) L166/395/774/875/912/1116 | `hover:bg-gray-200 dark:hover:bg-gray-800` |
| TreeSidebar 标签计数 | [TreeSidebar.tsx#L672](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L672), [L737](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L737) | `bg-gray-200 dark:bg-gray-800` |
| TreeSidebar 任务卡片 | [TreeSidebar.tsx#L1623](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1623) | `bg-white dark:bg-gray-800` |
| TreeSidebar 设置区域背景 | [TreeSidebar.tsx#L1679](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1679) | `bg-gray-50 dark:bg-gray-800/50` |
| TreeSidebar 设置按钮 hover | [TreeSidebar.tsx#L1724](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1724) | `hover:bg-gray-100 dark:hover:bg-gray-800` |

## 提议的修改

### 决策
- **背景色**：浅色 `bg-white`，深色 `bg-[#262626]`（用 Tailwind 任意值语法，无需改 config）
- **高亮色**：浅色保持 `bg-gray-100`，深色从 `dark:bg-gray-800`(#1f2937) 提升为 `dark:bg-[#3a3a3a]`（纯灰，与 #262626 形成约 14 亮度差）
- **hover 色**：浅色保持 `hover:bg-gray-100`，深色从 `dark:hover:bg-gray-800` 提升为 `dark:hover:bg-[#3a3a3a]`
- **半透明高亮**：`dark:bg-gray-800/50` → `dark:bg-[#3a3a3a]/50`
- **TabBar**：完全保持不变（用户明确要求）

### 1. App.tsx — 移除分隔线 + 统一背景

**1a. 左侧 Sidebar 容器**（[L2954-L2957](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2954-L2957)）
- 移除 `border-r border-gray-200 dark:border-gray-800`
- 背景色：`bg-gray-50 dark:bg-gray-850` → `bg-white dark:bg-[#262626]`

**1b. 主内容区**（[L2963](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2963)）
- 背景色：`bg-white dark:bg-gray-900` → `bg-white dark:bg-[#262626]`

**1c. 根容器**（[L2889](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2889)）
- 背景色：`bg-white dark:bg-gray-900` → `bg-white dark:bg-[#262626]`

**1d. 面包屑导航**（[L3207](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3207)）
- 移除 `border-b border-gray-200 dark:border-gray-800`
- 背景色：`bg-gray-50 dark:bg-gray-900` → `bg-white dark:bg-[#262626]`

**1e. 右侧 MetadataPanel 容器**（[L3572-L3575](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3572-L3575)）
- 移除 `border-l border-gray-200 dark:border-gray-800`
- 背景色：`bg-gray-50 dark:bg-gray-850` → `bg-white dark:bg-[#262626]`

**1f. 右侧 ColorPickerPanel 容器**（[L3605-L3608](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L3605-L3608)）
- 移除 `border-l border-gray-200 dark:border-gray-800`
- 背景色：`bg-white dark:bg-gray-800` → `bg-white dark:bg-[#262626]`

### 2. TopBar.tsx — 移除分隔线 + 统一背景 + 提升高亮

**2a. 根元素**（[L768](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L768)）
- 移除 `border-b border-gray-200 dark:border-gray-800`
- 背景色：`bg-white dark:bg-gray-900` → `bg-white dark:bg-[#262626]`

**2b. 搜索框背景**（[L888](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L888)）
- `bg-gray-100 dark:bg-gray-800` → `bg-gray-100 dark:bg-[#3a3a3a]`

**2c. 按钮 hover 与激活态**（约 17 处，全文替换）
- `hover:bg-gray-100 dark:hover:bg-gray-800` → `hover:bg-gray-100 dark:hover:bg-[#3a3a3a]`
- `bg-gray-100 dark:bg-gray-800`（激活态，如 sortMenuOpen/viewMenuOpen 时）→ `bg-gray-100 dark:bg-[#3a3a3a]`
- 用 `replace_all` 谨慎操作；需先 Read 确认这些 className 不含其他需要保留的 dark:bg-gray-800 场景

### 3. TabBar.tsx — 移除底部分隔线（保持背景不变）

**[L355](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx#L355)**
- 移除 `border-b border-gray-300 dark:border-gray-800`
- 背景色 `bg-gray-200 dark:bg-gray-900` **保持不变**

### 4. TreeSidebar.tsx — 移除分隔线 + 移除字样 + 统一背景 + 提升高亮

**4a. 移除"资源目录"字样**（[L1485-L1489](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1485-L1489)）
- 整个 `{!isAndroidPlatformCached() && (<div>...资源目录...</div>)}` 块删除

**4b. 移除"本地磁盘 & 局域网支持"字样**（[L1742-L1744](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1742-L1744)）
- 整个 `<div className="p-2 bg-gray-100 dark:bg-gray-850 border-t ...">...</div>` 块删除

**4c. 移除任务区域顶部分隔线**（[L1611](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1611)）
- `border-t border-gray-200 dark:border-gray-800` 删除
- 背景色 `bg-gray-50 dark:bg-gray-900/50` → `bg-white dark:bg-[#262626]`（与主背景统一）

**4d. 移除设置区域顶部分隔线 + 统一背景**（[L1679](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1679)）
- `border-t border-gray-200 dark:border-gray-800` 删除
- 背景色 `bg-gray-50 dark:bg-gray-800/50` → `bg-white dark:bg-[#262626]`

**4e. 移除设置按钮顶部分隔线**（[L1721](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1721)）
- `border-t border-gray-200 dark:border-gray-800` 删除

**4f. 节点 hover 高亮提升**（L166/395/774/875/912/1116 共 6 处）
- `hover:bg-gray-200 dark:hover:bg-gray-800` → `hover:bg-gray-200 dark:hover:bg-[#3a3a3a]`

**4g. 标签计数背景提升**（[L672](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L672), [L737](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L737)）
- `bg-gray-200 dark:bg-gray-800` → `bg-gray-200 dark:bg-[#3a3a3a]`

**4h. 任务卡片背景提升**（[L1623](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1623)）
- `bg-white dark:bg-gray-800` → `bg-white dark:bg-[#3a3a3a]`

**4i. 设置按钮 hover 提升**（[L1724](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1724)）
- `hover:bg-gray-100 dark:hover:bg-gray-800` → `hover:bg-gray-100 dark:hover:bg-[#3a3a3a]`

### 5. FileGrid.tsx — 提升高亮颜色

**5a. 文件/文件夹卡片默认背景**（[L594](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx#L594)）
- `bg-gray-100 dark:bg-gray-800` → `bg-gray-100 dark:bg-[#3a3a3a]`

**5b. 文件夹分组标题 + hover**（[L845](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx#L845)）
- `bg-gray-50 dark:bg-gray-900` → `bg-white dark:bg-[#262626]`（与背景统一）
- `hover:bg-gray-100 dark:hover:bg-gray-800` → `hover:bg-gray-100 dark:hover:bg-[#3a3a3a]`
- 注意：`border-b border-gray-200 dark:border-gray-800` 此处为分组标题分隔线，**保留**（分组标题需要分隔线区分）

## 不修改的部分

- **TabBar.tsx 背景**（`bg-gray-200 dark:bg-gray-900`）：用户明确要求保持不变
- **安卓端状态栏占位 div**（[App.tsx#L2933](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2933) `bg-gray-200 dark:bg-gray-900`）：与 TabBar 背景一致，保持不变
- **MetadataPanel 内部分隔线**（如 `border-t border-gray-100 dark:border-gray-800`）：面板内部信息分组分隔线，属于信息架构，不在用户移除范围内
- **FileGrid 分组标题分隔线**（L845 的 `border-b`）：分组标题需要分隔线区分
- **弹窗、下拉菜单、tag 预览等浮动元素**：这些是独立的浮层 UI，不在统一背景范围内
- **TopicModule、PersonGrid 等其他视图**：用户未提及，本次不修改
- **Android 原生 NativeGalleryView/SlideshowView**：原生图片查看器有独立 UI 主题，与主界面侧边栏/顶部栏无关，不在本次颜色统一范围

## 安卓端与 PC 端同步说明

本次修改的所有文件（App.tsx、TopBar.tsx、TabBar.tsx、TreeSidebar.tsx、FileGrid.tsx）均为**安卓端与 PC 端共用的 React 组件**，修改会**同时生效**于两端，无需为安卓端单独处理。

需要特别留意的安卓端已有逻辑（**不要破坏**）：
1. **TreeSidebar "资源目录"字样**（[L1485](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TreeSidebar.tsx#L1485)）：原本就有 `{!isAndroidPlatformCached() && (...)}` 判断，安卓端本来就不渲染。删除整个块对两端都安全。
2. **安卓状态栏占位 div**（[App.tsx#L2933](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2933)）：背景色 `bg-gray-200 dark:bg-gray-900` 与 TabBar 一致，**保持不变**。
3. **TopBar `android-topbar` 类**（[TopBar.tsx#L768](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L768)）：保留 `${isAndroid ? 'android-topbar' : ''}` 判断，只改背景色和移除 border-b。

验证时需要在**安卓端和 PC 端分别**检查浅色/深色主题下的：
- 背景统一为 #ffffff / #262626
- 分隔线已移除
- 高亮颜色提升为 #3a3a3a

## 假设与决策

### 假设
1. Tailwind 任意值语法 `bg-[#262626]` 和 `bg-[#3a3a3a]` 在项目中可用（Tailwind v3+ 默认支持，无需改 config）
2. `#3a3a3a` 作为高亮色与 `#262626` 背景的对比度足够（亮度差约 14，符合 WCAG 非文本对比度 3:1 建议用于 UI 组件）
3. TreeSidebar 中 `dark:bg-gray-800` 全部为高亮用途，可以统一替换为 `dark:bg-[#3a3a3a]`（已逐一确认无例外）

### 决策
- **高亮色选择 #3a3a3a**：介于 #262626（背景）和 #525252（neutral-600）之间，提供适度对比但不过于刺眼；纯灰色调与 #262626 协调
- **浅色主题保持 bg-gray-100 作为高亮**：浅色背景为 #ffffff，gray-100 (#f3f4f6) 提供足够对比，无需调整
- **保留 FileGrid 分组标题分隔线**：分组标题需要视觉分隔，否则分组不清晰
- **不扩展 Tailwind config**：用任意值语法 `bg-[#hex]` 避免增加配置复杂度

## 验证步骤

### 浅色主题验证
1. 启动应用，切换到浅色主题
2. 检查 TopBar、左侧 Sidebar、右侧 MetadataPanel、主内容区、面包屑导航背景均为纯白 #ffffff
3. 检查 TabBar 背景仍为 bg-gray-200（浅灰）
4. 检查 TopBar 下方无分隔线，TabBar 下方无分隔线
5. 检查左侧 Sidebar 与主内容区之间无垂直分隔线
6. 检查右侧 MetadataPanel 与主内容区之间无垂直分隔线
7. 检查左侧 Sidebar 顶部无"资源目录"字样
8. 检查左侧 Sidebar 底部无"本地磁盘 & 局域网支持"字样
9. 检查左侧 Sidebar 设置区域上下无分隔线
10. 检查面包屑导航下方无分隔线
11. 检查文件/文件夹卡片背景为 bg-gray-100，hover 时仍为 bg-gray-100
12. 检查 TopBar 按钮 hover 时背景为 bg-gray-100

### 深色主题验证
1. 切换到深色主题
2. 检查 TopBar、左侧 Sidebar、右侧 MetadataPanel、主内容区、面包屑导航背景均为 #262626
3. 检查 TabBar 背景仍为 dark:bg-gray-900
4. 检查所有分隔线已移除（同浅色主题）
5. 检查文件/文件夹卡片背景为 #3a3a3a（比背景 #262626 亮一档）
6. 检查 TopBar 按钮 hover 时背景为 #3a3a3a
7. 检查 TopBar 搜索框背景为 #3a3a3a
8. 检查 TreeSidebar 节点 hover 时背景为 #3a3a3a
9. 检查高亮颜色与背景有明显对比，但不刺眼

### 功能回归
1. 标签页切换、新建、关闭功能正常
2. 文件浏览、文件夹展开/折叠正常
3. 搜索框、排序菜单、视图切换菜单正常
4. 右侧元数据面板、颜色选择器面板正常
5. 设置按钮可点击打开设置
