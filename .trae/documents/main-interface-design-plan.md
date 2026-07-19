# 主界面无分隔线层次设计规划

## 摘要

当前主界面已统一为 `#ffffff` / `#262626` 并去除了大部分分隔线，但界面显得过平、缺少层次。本次规划在不重新引入显式分隔线的前提下，通过「背景色微差 + 统一间距 + 卡片/表面层级」重建视觉层次：

- **顶部工具栏**：完全扁平，与主内容区背景一致，统一按钮尺寸与 hover 表面色。
- **左右侧面板**：使用比主内容区稍有不同的背景色（深色模式下稍亮于 `#262626`），形成柔和分区。
- **文件区域**：增加统一外间距，弱化卡片边框，优化分组标题，强化内容网格感。
- **元数据面板**：内部卡片背景与面板背景协调，统一细碎分隔线为柔和边框。

默认实施方案 **A（保守微差）**，并预留 B/C 两套色板备选。

## 当前状态分析

### 关键文件与现状

| 区域 | 文件 | 现状要点 |
|------|------|----------|
| 根容器 / 主布局 | `src/App.tsx` | 根容器、主内容区、左右面板之前统一使用 `bg-white dark:bg-[#262626]`；部分修改已开始替换为 `bg-main` / `bg-panel`。 |
| 顶部工具栏 | `src/components/TopBar.tsx` | 已改为 `bg-main`；按钮 hover 已部分替换为 `hover:bg-surface`；但按钮尺寸仍有 `p-2` / `w-10 h-10` 混用，搜索 scope 分隔线仍用 `border-gray-300 dark:border-gray-800`。 |
| 左侧边栏 | `src/components/TreeSidebar.tsx` | 分区标题 hover 已开始替换为 `hover:bg-surface`；但展开内容区仍有 `bg-white dark:bg-[#262626]`，Section 间距细节不完全一致。 |
| 文件网格 | `src/components/FileGrid.tsx` | 滚动容器无统一外间距；卡片边框用 `border-gray-200 dark:border-gray-800`；分组标题底边框是唯一剩余横向分隔线，对比度偏高。 |
| 元数据面板 | `src/components/MetadataPanel.tsx` | 内部大量使用 `bg-gray-100 dark:bg-[#3a3a3a]`、`bg-gray-50/50 dark:bg-[#3a3a3a]/30`、`border-gray-200 dark:border-gray-800` 等，与新的面板色不够协调。 |
| 全局样式 | `index.css` | 已新增 `.bg-main`、`.bg-panel`、`.bg-surface`、`.border-subtle` 工具类。 |
| Tailwind 配置 | `tailwind.config.js` | `darkMode: 'class'`，无自定义面板/表面 token，本次通过普通 CSS 类补充。 |

### 主要问题

1. 左右面板与主内容区若仍使用同一背景色，宽屏下边界模糊。
2. TopBar 按钮视觉权重不均，搜索框在不同状态下颜色跳跃。
3. 文件网格直接贴边，缺少呼吸感；分组标题底边框偏硬。
4. TreeSidebar 展开区背景与面板背景不一致，Section 节奏略有参差。
5. MetadataPanel 内部仍存在多种硬编码灰阶，与新的设计 token 不统一。

## 设计方向

### 核心原则

- **无分隔线**：不引入 `border-r` / `border-l` / `border-b` 作为区域分隔。
- **背景色微差**：用 1-2 个明度阶差区分「主内容区 / 左右面板 / 卡片表面」。
- **间距即分隔**：通过统一 padding / margin 让面板与内容自然隔离。
- **扁平 TopBar**：TopBar 与主内容区背景一致，不额外加背景差、阴影或边框。
- **卡片表面层级**：文件卡片、元数据卡片使用比背景稍亮的表面色，保持可点击感。

### 默认方案 A（保守微差）

| 层级 | 浅色模式 | 深色模式 | 用途 |
|------|----------|----------|------|
| 主内容区 / TopBar | `#ffffff` | `#262626` | 窗口主背景、顶部工具栏 |
| 左右面板 | `#f7f7f7` | `#2a2a2a` | Sidebar、MetadataPanel、Android 取色器面板 |
| 卡片表面 | `#f3f4f6` | `#3a3a3a` | 文件卡片、元数据内部卡片、搜索框、按钮 hover |
| 柔和边框 | `#e5e7eb` | `#404040` | 卡片边框、输入框边框 |

### 备选色板

| 方案 | 名称 | 左右面板（浅色） | 左右面板（深色） | 卡片表面（浅色） | 卡片表面（深色） | 风格 |
|------|------|------------------|------------------|------------------|------------------|------|
| B | 清晰分区 | `#f3f4f6` | `#333333` | `#e5e7eb` | `#404040` | 面板分界更明显 |
| C | 极简统一 | `#fafafa` | `#282828` | `#f3f4f6` | `#3a3a3a` | 接近主背景，靠间距区分 |

> 若切换方案 B/C，只需修改 `index.css` 中 `.bg-panel` 与 `.dark .bg-panel` 的色值。

## 提议的修改

### 1. 设计令牌（`index.css`）

确保以下 token 已存在（如已存在则核对色值）：

```css
/* Main interface surface tokens */
.bg-main {
  background-color: #ffffff;
}
.dark .bg-main {
  background-color: #262626;
}

.bg-panel {
  background-color: #f7f7f7;
}
.dark .bg-panel {
  background-color: #2a2a2a;
}

.bg-surface {
  background-color: #f3f4f6;
}
.dark .bg-surface {
  background-color: #3a3a3a;
}

.border-subtle {
  border-color: #e5e7eb;
}
.dark .border-subtle {
  border-color: #404040;
}
```

### 2. `src/App.tsx` — 面板与主内容区背景

- 根容器：使用 `bg-main`。
- 左侧 Sidebar 容器：使用 `bg-panel`。
- 主内容区：使用 `bg-main`。
- 右侧 MetadataPanel 容器：使用 `bg-panel`。
- Android 取色器面板：使用 `bg-panel`。

> 保持容器之间无左右边框。

### 3. `src/components/TopBar.tsx` — 完全扁平 + 按钮统一

- 根元素保持 `bg-main`。
- 所有图标按钮统一尺寸：
  - 桌面端：`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface`。
  - Android：`w-10 h-10 ... rounded-xl hover:bg-surface`。
- 搜索框：平时与背景融合（`bg-transparent border-transparent hover:bg-surface/50`），有 query 或 focus 时显示 `bg-surface border-subtle`。
- 搜索 scope 分隔线改为 `border-subtle`。

### 4. `src/components/TreeSidebar.tsx` — 面板背景适配 + 分区节奏

- 所有显式 `bg-white dark:bg-[#262626]` 替换为 `bg-panel`（展开内容区、任务区域外框、模型下载区等）。
- 任务卡片等次级表面替换为 `bg-surface`。
- Section Header 统一：
  - 高度 `40px`（桌面）/ `55px`（Android）。
  - 左右缩进统一为 `margin: '0 12px'`。
  - 分区之间使用 `mt-2 first:mt-0`。
  - hover 统一为 `hover:bg-surface`。
- 展开内容区内边距统一为 `pl-5 pr-3 pb-3 mt-1`。
- 标签/人物计数徽章背景改为 `bg-surface`，文字色 `text-gray-500 dark:text-gray-400`。

### 5. `src/components/FileGrid.tsx` — 文件区域呼吸感 + 分组标题

- 滚动容器增加统一外间距 `p-4`；若与绝对定位虚拟列表冲突，则改为给内部高度容器加 `p-4`。
- 文件卡片边框改为 `border-subtle`，hover 边框保持 `hover:border-gray-400 dark:hover:border-gray-500`，背景改为 `bg-surface`。
- 分组标题：
  - 改为 `py-2 px-4`。
  - 背景改为 `bg-main/80 backdrop-blur-sm`。
  - 底边框改为 `border-subtle`。
  - hover 改为 `hover:bg-surface`。
- 分组标题计数徽章改为 `bg-surface`。

### 6. `src/components/MetadataPanel.tsx` — 内部卡片与分隔线统一

- 顶部图片预览框：背景 `bg-surface`，边框 `border-subtle`。
- CategorySelector 背景：`bg-surface`。
- DistributionChart 进度条槽：`bg-surface`。
- Topic 列表卡片：`bg-surface/60` + `border-subtle`，hover `bg-surface`。
- Topic stats badges：`bg-surface`。
- 统一内部所有 `border-gray-200 dark:border-gray-800` / `border-gray-100 dark:border-gray-800` 为 `border-subtle`。

## 不修改的部分

- TabBar 背景保持现有 `bg-gray-200 dark:bg-gray-900`。
- Android 状态栏占位保持现状。
- 文件夹/人物/Topic 选中态颜色保持不变。
- 弹窗/下拉菜单/浮动面板不在本次主界面层级调整范围内。
- ImageViewer / Android 原生视图独立主题，不在本次范围。

## 假设与决策

1. Tailwind 自定义 CSS 类（`.bg-main` 等）可直接在 `className` 中使用，不会被 Tailwind 覆盖。
2. 深色面板稍亮于主内容区（方案 A `#2a2a2a`），符合用户选择。
3. 搜索框 focus 状态通过局部状态实现；如实现成本过高，可退化为「始终 `bg-surface border-transparent hover:border-subtle`」。
4. 文件网格 `p-4` 不影响绝对定位卡片坐标；若实测偏移，改为给内部高度容器加 padding。
5. TopBar 完全扁平，不添加阴影或背景差。

## 验证步骤

### 浅色主题

1. 启动应用，检查根容器、主内容区、TopBar 背景为 `#ffffff`。
2. 检查左右面板背景为 `#f7f7f7`，与主内容区之间无垂直分隔线。
3. 检查 TopBar 下方无阴影/分隔线，按钮尺寸统一，hover 为 `#f3f4f6`。
4. 检查搜索框平时与 TopBar 融合，focus/query 时有柔和背景/边框。
5. 检查文件卡片背景 `#f3f4f6`、边框 `#e5e7eb`，网格四周有 `p-4` 留白。
6. 检查分组标题半透明毛玻璃、底边框柔和。
7. 检查 Sidebar Section 标题间距一致，展开区背景与面板一致。
8. 检查 MetadataPanel 内部卡片背景/边框协调，无突兀深色分隔线。

### 深色主题

1. 检查主内容区/TopBar 为 `#262626`。
2. 检查左右面板为 `#2a2a2a`，比主内容区稍亮。
3. 重复浅色主题对应检查，确认所有 `dark:` 颜色正确。
4. 检查文件卡片 `#3a3a3a` 在 `#262626` 上仍有柔和层级。
5. 检查 Sidebar 选中态（蓝色/紫色/粉色）在新面板背景上依然醒目。

### 功能回归

1. 标签页切换、新建、关闭正常。
2. 文件夹展开/折叠、拖拽投放正常。
3. 搜索框 focus/blur、scope 切换、颜色搜索正常。
4. 视图模式切换、排序、分组正常。
5. 元数据面板滚动、标签编辑、人物选择正常。
6. Android 端横竖屏切换、侧栏/元数据面板显隐正常。
