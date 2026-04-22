# 安卓端虚拟滚动优化 & 移除分页限制

## 问题分析

### 问题1：快速滚动时出现空白区域
**根因**：当前虚拟滚动方案存在两层"懒加载"叠加：
1. **DOM 层虚拟化**：`visibleItems` 基于 `scrollTop` 状态过滤，但 `scrollTop` 通过 React `useState` 更新，存在一帧延迟。快速滚动时，DOM 元素被移除后新的还没来得及挂载。
2. **缩略图懒加载**：`ImageThumbnail` 内部有 `useInView` + 异步 `getThumbnail()`，即使 DOM 已挂载，缩略图仍需等待 IntersectionObserver 触发 + 异步加载。

系统相册的做法是：**DOM 元素始终存在（不虚拟化移除），只对缩略图加载做懒加载**，因此快速滚动时总能看到占位符，不会出现空白。

### 问题2：滚动帧率不稳定
**根因**：缩略图生成（`getThumbnail`）在主线程/WebView 线程执行，大量并发缩略图请求会阻塞渲染。

### 问题3：1000 张图片分页限制
**根因**：`useFileSearch.ts` 中硬编码 `const pageSize = 1000`，通过 `allMatchingFileIds.slice()` 截断。这是桌面端的优化策略，移动端相册应用通常不分页。

---

## 优化方案

### 方案核心思路

参考系统相册的做法，采用 **"宽进宽出"的虚拟滚动策略**：
- 大幅扩大 DOM 虚拟化的渲染窗口，确保快速滚动时不会出现空白
- 缩略图加载保持懒加载，但预加载距离足够大
- 安卓端移除分页限制，展示全部图片
- 滚动状态感知：快速滚动时降低缩略图质量/延迟加载

---

## 实施步骤

### Step 1：安卓端移除分页限制

**文件**: `src/hooks/useFileSearch.ts`

修改分页逻辑，安卓端不进行分页切片：

```typescript
// 之前
const pageSize = 1000;
const currentPage = activeTab.currentPage || 1;
const totalResults = allMatchingFileIds.length;

const displayFileIds = useMemo(() => {
  const start = (currentPage - 1) * pageSize;
  return allMatchingFileIds.slice(start, start + pageSize);
}, [allMatchingFileIds, currentPage]);

// 之后：安卓端不分页，桌面端保持原逻辑
const isAndroid = state.settings.paths.resourceRoot === 'android_media_store';
const pageSize = isAndroid ? allMatchingFileIds.length : 1000;
const currentPage = activeTab.currentPage || 1;
const totalResults = allMatchingFileIds.length;

const displayFileIds = useMemo(() => {
  if (isAndroid) return allMatchingFileIds;
  const start = (currentPage - 1) * pageSize;
  return allMatchingFileIds.slice(start, start + pageSize);
}, [allMatchingFileIds, currentPage, isAndroid, pageSize]);
```

**文件**: `src/App.tsx`

安卓端隐藏分页控件（App.tsx 中约 L2011 的分页 UI 区域）。在安卓端，`totalResults > pageSize` 永远为 false（因为 pageSize = totalResults），所以分页控件自然不会显示。但需确认筛选栏整体在安卓端也不显示多余内容。

### Step 2：优化虚拟滚动 — 扩大渲染窗口

**文件**: `src/components/FileGrid.tsx`

将 `visibleItems` 的缓冲区策略从固定值改为**基于总内容高度的自适应策略**：

```typescript
const visibleItems = useMemo(() => {
    // 策略：渲染窗口 = 视口高度 * 倍数，但不超过总高度
    // 桌面端：3倍视口（平衡性能）
    // 安卓端：5倍视口（确保快速滚动不空白）
    const isAndroid = effectiveResourceRoot === 'android_media_store';
    const multiplier = isAndroid ? 5 : 3;
    const buffer = Math.max(1200, containerRect.height * multiplier);
    const minY = scrollTop - buffer;
    const maxY = scrollTop + containerRect.height + buffer;
    return layout.filter(item => item.y < maxY && item.y + item.height > minY);
}, [layout, scrollTop, containerRect.height, totalHeight, effectiveResourceRoot]);
```

同样修改 `GroupContent` 中的 `visibleItems`。

### Step 3：滚动状态感知 — 快速滚动时延迟缩略图加载

**文件**: `src/components/FileGrid.tsx`

添加滚动速度检测，快速滚动时暂停缩略图加载：

1. 在 FileGrid 中追踪滚动速度
2. 通过 Context 或 prop 将 `scrollState`（idle/scrolling/fast）传递给子组件
3. `ImageThumbnail` 在 `fast` 状态下只显示占位符，不发起缩略图请求

```typescript
// FileGrid 中添加滚动状态检测
const scrollStateRef = useRef<'idle' | 'scrolling' | 'fast'>('idle');
const lastScrollTimeRef = useRef(0);
const lastScrollTopRef = useRef(0);

// 在 scroll handler 中更新
const handleScroll = () => {
    const now = Date.now();
    const dt = now - lastScrollTimeRef.current;
    const dy = Math.abs(containerRef.current.scrollTop - lastScrollTopRef.current);
    
    if (dt < 50 && dy > 100) {
        scrollStateRef.current = 'fast';
    } else if (dt < 150) {
        scrollStateRef.current = 'scrolling';
    } else {
        scrollStateRef.current = 'idle';
    }
    
    lastScrollTimeRef.current = now;
    lastScrollTopRef.current = containerRef.current.scrollTop;
    // ...
};
```

**文件**: `src/components/ImageThumbnail.tsx`

根据 `scrollState` 控制缩略图加载行为：
- `idle`：正常加载高清缩略图
- `scrolling`：正常加载，但跳过升级检查
- `fast`：只显示占位符/缓存中已有的缩略图，不发起新请求

### Step 4：缩略图加载并发控制

**文件**: `src/components/ImageThumbnail.tsx` 或新建 `src/utils/thumbnailQueue.ts`

添加全局缩略图加载队列，限制并发数：
- 最大并发数：3-5 个（避免 WebView 线程阻塞）
- 优先加载可视区域内的缩略图
- 快速滚动时暂停队列

### Step 5：FoldersOverview 同步优化

**文件**: `src/components/FoldersOverview.tsx`

- 同步 Step 2 的渲染窗口扩大策略
- 文件夹数量通常不多（~100），可考虑不虚拟化

---

## 修改文件清单

| 文件 | 修改内容 |
|------|---------|
| `src/hooks/useFileSearch.ts` | 安卓端不分页，pageSize 动态化 |
| `src/App.tsx` | 安卓端隐藏分页相关 UI |
| `src/components/FileGrid.tsx` | 扩大渲染窗口 + 滚动状态检测 + 传递 scrollState |
| `src/components/ImageThumbnail.tsx` | 根据 scrollState 控制加载行为 |
| `src/components/FoldersOverview.tsx` | 同步渲染窗口策略 |
| `src/utils/thumbnailQueue.ts`（新建） | 全局缩略图加载队列 |

---

## 风险评估

1. **安卓端不分页可能导致内存问题**：8000+ 图片的 layout 计算在 Worker 中完成，不会阻塞主线程；`displayFileIds` 只是 ID 数组，内存占用极小。真正的内存消耗在缩略图缓存（LRU 1000项），不受分页影响。
2. **扩大渲染窗口增加 DOM 节点数**：5倍视口约 20-30 排，每排 3-4 个 = 60-120 个 DOM 节点，现代 WebView 完全能承受。
3. **缩略图队列可能增加首屏延迟**：通过优先级队列（可视区域优先）缓解。
