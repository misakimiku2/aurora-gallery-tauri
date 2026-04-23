# FoldersOverview 帧率优化计划

## 问题分析

主界面（FoldersOverview，~100 个文件夹卡片）滚动帧率明显低于文件夹内部（FileGrid，可能数千张图片），核心原因如下：

### 根因 1：FolderCard DOM 复杂度过高（最关键）

每个 FolderCard 包含多层昂贵 DOM 元素：
- `backdrop-blur-sm` — Android WebView 上极其昂贵，每帧都需要高斯模糊计算
- `bg-gradient-to-t from-black/70 via-black/30 to-transparent` — 半透明渐变叠加层，120Hz 下每帧重绘
- `shadow-sm hover:shadow-md transition-shadow duration-200` — 阴影过渡动画
- `animate-spin` SVG 旋转动画 — 升级中时持续触发 DOM 重绘
- 多个绝对定位元素（渐变遮罩、图标、数量标签）

对比 FileGrid 的 ImageThumbnail：仅一个 `<img>` + 可选升级遮罩，DOM 极简。

### 根因 2：React 不必要的重渲染

- `FoldersOverview` 组件未用 `React.memo` 包裹
- App.tsx 中 `onFolderClick={(folderId) => enterFolder(folderId)}` 每次渲染创建新函数
- App.tsx 中 `onScrollTopChange={(scrollTop) => { updateActiveTab({ scrollTop }); }}` 每次渲染创建新函数
- `onClick={() => onFolderClick(pos.id)}` 每个 visibleItem 每次渲染创建新函数
- `files` 对象引用频繁变化导致 `folderNodes`/`sortedFolderIds` 重计算

### 根因 3：升级遮罩未感知滚动状态

当前 FolderCard 的升级遮罩（`upgrading` 状态）**没有订阅全局滚动状态**，在滚动中仍显示 `animate-spin` SVG 动画，导致持续 DOM 重绘掉帧。文档中提到应该检查 `scrollState === 'idle'`，但代码未实现。

### 根因 4：缺少 GPU 合成层优化

- FolderCard 容器没有 `will-change: transform` 或 `contain` 属性
- 浏览器无法将卡片提升为独立合成层，滚动时需要重绘更多区域

---

## 实施步骤

### 步骤 1：重写 FolderCard — 极简 DOM 结构

**目标**：将 FolderCard 的 DOM 复杂度降到与 ImageThumbnail 同等水平。

**具体改动**（`src/components/FoldersOverview.tsx`）：

1. **移除 `backdrop-blur-sm`**：数量标签改为 `bg-black/50` 纯色半透明背景
2. **移除渐变叠加层**：删除 `<div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent pt-8 pb-2 px-2" />`
3. **移除 hover 阴影过渡**：删除 `shadow-sm hover:shadow-md transition-shadow duration-200`，改为静态样式
4. **添加 `will-change: transform`**：在卡片容器上添加，提升为 GPU 合成层
5. **添加 `contain: layout style paint`**：隔离卡片布局，减少浏览器重排范围
6. **简化文件夹图标**：将内联 SVG 改为更简单的圆角矩形或直接移除（封面图已有视觉区分）
7. **订阅滚动状态**：FolderCard 内部订阅 `subscribeScrollState`，升级遮罩仅在 `idle` 时显示

重写后的 FolderCard 结构：
```
<div will-change:transform contain:layout>
  <div rounded-lg overflow-hidden>
    <img /> 或 <Folder 占位符>
    {upgrading && idle && <暗色遮罩+Spinner>}
    <绝对定位: 文件夹图标+数量>  ← 简化，无backdrop-blur
  </div>
  <文字标签>
</div>
```

### 步骤 2：FoldersOverview React 优化

**目标**：消除不必要的重渲染。

**具体改动**：

1. **用 `React.memo` 包裹 `FoldersOverview`**：浅比较 props
2. **App.tsx 中稳定化回调**：
   - `onFolderClick` 用 `useCallback` 包裹
   - `onScrollTopChange` 用 `useCallback` + `throttle` 包裹
3. **FoldersOverview 内部稳定化 `onClick`**：
   - 使用 `useCallback` + `data-id` 属性的事件委托模式，或
   - 使用 `useCallback` 返回稳定引用的 `onFolderClick` 传给 FolderCard
4. **优化 `folderNodes` 和 `sortedFolderIds` 的依赖**：避免因 `files` 引用变化导致重计算

### 步骤 3：滚动状态感知集成

**目标**：滚动时隐藏所有动画效果，消除 DOM 重绘。

**具体改动**（`src/components/FoldersOverview.tsx` FolderCard 内部）：

1. 添加 `subscribeScrollState` 订阅
2. 升级遮罩条件改为：`upgrading && (scrollState === 'idle' || !isAndroid)`
3. 与 ImageThumbnail 和 FolderThumbnail 保持一致的行为

### 步骤 4：CSS 性能优化

**目标**：最大化 GPU 合成效率。

**具体改动**：

1. **卡片容器**：添加 `will-change: transform` + `contain: layout style paint`
2. **图片容器**：添加 `will-change: transform` 确保图片在独立合成层
3. **移除 `dangerouslySetInnerHTML`**：将 scrollbar 隐藏 CSS 改为一次性注入（使用 `useEffect` + `document.head.appendChild`）
4. **减少 CSS 类切换**：移除 `group` 类（hover 效果在触摸屏无意义）

### 步骤 5：验证与微调

1. 在三星 Tab S8+ 上使用 Chrome DevTools Performance 面板验证帧率
2. 确认滚动帧率接近 120fps
3. 确认文件夹缩略图立即显示
4. 确认升级过渡效果（暗色遮罩+转圈）在停止滚动后正常显示
5. 确认快速启动进入主界面

---

## 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/components/FoldersOverview.tsx` | **重写** | FolderCard 极简化 + React.memo + 滚动状态感知 + CSS 优化 |
| `src/App.tsx` | 修改 | 稳定化 FoldersOverview 的回调 props（useCallback） |

---

## 保留的功能

1. ✅ 开启软件时直接快速进入主界面（现有缓存优先策略不变）
2. ✅ 文件夹缩略图立即显示（LRU 缓存 + 预填充策略不变）
3. ✅ 升级过渡效果（暗色遮罩+转圈动画）— 仅在滚动停止后显示
4. ✅ 文件夹名称 + 图片数量显示
5. ✅ 点击进入文件夹
6. ✅ 滚动位置恢复
7. ✅ CSS 隐藏保持挂载（返回不重新加载）

## 预期效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 主界面滚动帧率 | ~60fps 或更低 | 接近 120fps（匹配屏幕刷新率） |
| FolderCard DOM 节点数 | ~12 个/卡片 | ~6 个/卡片 |
| 滚动中 DOM 重绘 | animate-spin + backdrop-blur 持续触发 | 无动画、无重绘 |
| React 重渲染次数 | files 变化时全部重渲染 | props 未变时跳过 |
