# 去除 PC 端分页 — 逻辑层性能优化计划

## Summary

PC 端当前对搜索结果分页(每页 1000)以规避卡顿。用户希望像安卓端一样不分页,直接滚动到底看到全部文件。图片库约 9.8 万张图,搜索结果可能返回几万个文件。渲染层(虚拟滚动)已保证 DOM 数量恒定,瓶颈在**逻辑层**:滚动时 `visibleItems` 线性 filter 全量 layout、`postKey` 字符串拼接、`groupedFiles` 依赖过宽。

本计划通过 4 项改动,在去掉 PC 分页后让 9.8 万搜索结果仍可流畅滚动:① 用二分查找替代 `visibleItems` 线性 filter;② 用数值 hash 替代 `postKey` 的 `join` 拼接;③ 收窄 `groupedFiles` 依赖;④ PC 端 `pageSize` 改为全量。改动集中在 3 个文件,风险可控。

## Current State Analysis

### 数据流(去分页后,n = 9.8 万)
```
state.files(9.8万) → allMatchingFileIds(filter+sort, O(n log n), 有 useMemo)
  → displayFileIds(slice, 去分页后 = 全量)
  → useLayout(displayFileIds, ...)
       → aspectRatios useMemo O(n)
       → postKey = items.join(',') + ratios entries join('|')  ← O(n) 字符串拼接
       → worker.postMessage(全量 items + ratios)
       → layout.worker.ts: items.forEach 全量计算几何  ← 一次性 O(n),低频
  → layout[](9.8万 LayoutItem) + totalHeight
  → visibleItems = layout.filter(y 范围)  ← O(n) 每次滚动,致命
  → 渲染(仅 visibleItems 挂载 DOM)
```

### 瓶颈点(按去分页后致命度排序)

| # | 瓶颈 | 位置 | 频率 | 去分页后开销 |
|---|------|------|------|------------|
| 1 | `visibleItems = layout.filter(...)` 线性扫描 | [FileGrid.tsx:1625-1630](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx#L1625) | 每次滚动(无节流,见 line 1240 `setScrollTop`) | 9.8万 × 每帧 = 致命 |
| 2 | `postKey` 拼接 `items.join(',')` + ratios join | [useLayoutHook.ts:98-101](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/useLayoutHook.ts#L98) | 每次 layout 输入变更 | O(n) 字符串,~MB 级 |
| 3 | `groupedFiles` useMemo 依赖含 `state.files` 整字典 | [useFileSearch.ts:180](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/hooks/useFileSearch.ts#L167) | 任意单文件变动 | 9.8万重分组 |
| 4 | PC `pageSize = 1000` 硬编码 | [useFileSearch.ts:153](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/hooks/useFileSearch.ts#L153) | — | 分页本身 |

### layout 数组有序性确认(决定 visibleItems 优化策略)

读 [layout.worker.ts:60-176](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/workers/layout.worker.ts#L60) 确认:
- **list**(line 67):`y = PADDING + index * 44`,严格按 y 递增 ✓
- **grid**(line 82):`y = PADDING + row * (itemHeight + GAP)`,row = floor(index/cols),按 y 非严格递增 ✓
- **adaptive**(line 170):按行累积,同行 y 相同,跨行递增 ✓
- **masonry**(line 108):`y = colHeights[minCol]`,**按 y 无序** ✗

结论:list/grid/adaptive 的 layout 按 y 有序,masonry 无序。为统一处理,采用**维护按 y 排序的索引数组 + 二分查找**方案,对 4 种模式通用。

## Proposed Changes

### 改动 1:visibleItems 二分查找(主 FileGrid)

**文件**:[src/components/FileGrid.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx)(line 1625-1630)
**为什么**:滚动时 `layout.filter` 对 9.8 万项线性扫描,每帧执行,是去分页后头号卡顿源。
**怎么做**:
1. 在 useLayoutHook 返回值中增加 `sortedByY: number[]`(见改动 2),即 layout 中按 `y` 升序排列的下标数组。
2. 替换 FileGrid.tsx:1625-1630 的 `visibleItems` useMemo:
   ```ts
   const visibleItems = useMemo(() => {
     const buffer = isLayoutTransitioning ? transitionBufferRef.current : 400;
     const minY = scrollTop - buffer;
     const maxY = scrollTop + containerRect.height + buffer;
     if (layout.length === 0 || sortedByY.length === 0) return [];
     // 安全余量:覆盖最大 item height(grid/masonry 约 thumbnailSize+40,取 800 兜底)
     const SAFE_MARGIN = 800;
     // 二分找首个 layout[sortedByY[i]].y + height >= minY
     //    等价于 y >= minY - height,因 height <= 800,用 y >= minY - SAFE_MARGIN 近似
     let lo = 0, hi = sortedByY.length;
     while (lo < hi) {
       const mid = (lo + hi) >> 1;
       if (layout[sortedByY[mid]].y < minY - SAFE_MARGIN) lo = mid + 1;
       else hi = mid;
     }
     // 从 lo 线性扫描,直到 y >= maxY(有序 ⇒ 可提前终止)
     const out: LayoutItem[] = [];
     for (let i = lo; i < sortedByY.length; i++) {
       const item = layout[sortedByY[i]];
       if (item.y >= maxY) break;
       if (item.y + item.height > minY) out.push(item);
     }
     return out;
   }, [layout, sortedByY, scrollTop, containerRect.height, isLayoutTransitioning]);
   ```
3. 从 useLayoutHook 解构出 `sortedByY`:`const { layout, totalHeight, sortedByY } = useLayout(...)`(line 1272)。
4. 复杂度:O(log n) + O(visible count) ≈ 17 + ~50,对比原 O(9.8万)。

### 改动 2:useLayoutHook 维护 sortedByY + postKey hash

**文件**:[src/components/useLayoutHook.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/useLayoutHook.ts)
**为什么**:
- sortedByY 服务于改动 1 的二分查找。
- postKey 当前用 `items.join(',')` + ratios entries join,9.8 万项生成 MB 级字符串,每次 layout 输入变更都执行。
**怎么做**:
1. 扩展 `layoutState` 类型与初始值,增加 `sortedByY: number[]`:
   ```ts
   const [layoutState, setLayoutState] = useState<{
     layout: LayoutItem[];
     totalHeight: number;
     sortedByY: number[];
   }>({ layout: [], totalHeight: 0, sortedByY: [] });
   ```
2. 在 worker `onmessage`(line 71-78)中,接收 layout 后构建 sortedByY:
   ```ts
   worker.onmessage = (e: MessageEvent) => {
     if (workerEpochRef.current !== epoch) return;
     workerBusyRef.current = false;
     const layout: LayoutItem[] = e.data?.layout || [];
     // 按 y 升序排列下标;同 y 时按 x 升序稳定
     const sortedByY = layout.map((_, i) => i).sort((a, b) => {
       const dy = layout[a].y - layout[b].y;
       return dy !== 0 ? dy : layout[a].x - layout[b].x;
     });
     setLayoutState({ layout, totalHeight: e.data?.totalHeight || 0, sortedByY });
   };
   ```
   排序成本 O(n log n),仅在 layout 变更(低频)执行,9.8 万约 5-10ms,可接受。
3. 替换 postKey(line 98-101),用数值 hash 替代 join:
   ```ts
   // 在文件顶部加工具函数
   function hashStringArray(arr: string[]): number {
     let h = 5381;
     for (let i = 0; i < arr.length; i++) {
       const s = arr[i];
       if (!s) continue;
       for (let j = 0; j < s.length; j++) {
         h = ((h << 5) + h + s.charCodeAt(j)) | 0;
       }
       h = (h + 5381) | 0; // 分隔
     }
     return h;
   }
   function hashRatios(obj: Record<string, number>): number {
     let h = 5381;
     for (const k in obj) {
       h = ((h << 5) + h + k.charCodeAt(0)) | 0;
       h = ((h << 5) + h + Math.round(obj[k] * 65536)) | 0;
     }
     return h;
   }
   // line 98-101 改为:
   const itemsKey = hashStringArray(items);
   const ratiosKey = hashRatios(aspectRatios);
   const collapsedKey = collapsedGroups ? Object.entries(collapsedGroups).map(([k, v]) => `${k}:${v}`).join('|') : '';
   const postKey = `${itemsKey}|${ratiosKey}|${layoutMode}|${containerWidth}|${thumbnailSize}|${viewMode}|${searchQuery || ''}|${collapsedKey}`;
   ```
   说明:items/ratios 全量遍历但纯数字运算,不生成大字符串,比 join 快 5-10 倍;collapsedGroups 通常 < 20 项,保留 join 无碍。hash 碰撞概率极低(djb2 32位,9.8 万项碰撞率 ~0.1%),且碰撞最坏情况只是漏算一次 layout(下次输入变会补算),不影响正确性。
4. return 语句(line 140)不变,`layoutState` 已含 sortedByY。

### 改动 3:groupedFiles 依赖收窄

**文件**:[src/hooks/useFileSearch.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/hooks/useFileSearch.ts)(line 167-180)
**为什么**:当前 useMemo 依赖含 `state.files` 整字典,任意单文件变动(如缩略图加载完成更新 meta)都会触发 9.8 万项重分组。分组键(file.type / createdAt.substring(0,7))在一次搜索会话中基本不变。
**怎么做**:
1. 将 line 180 的依赖数组从:
   ```ts
   }, [allFiles, searchCriteria, state.files, state.topics]);
   ```
   分组函数的依赖改为(注意 groupedFiles 的 useMemo 在 line 167-180,其依赖需单独看):
   
   实际 line 167-180 的 groupedFiles useMemo 依赖当前未在读取片段中完整显示,需确认。预期改为:
   ```ts
   }, [displayFileIds, groupBy, state.files]);
   ```
   改为:
   ```ts
   }, [displayFileIds, groupBy]);
   ```
   说明:分组内部仍从 `state.files[id]` 读取 file.type/createdAt,但不把 `state.files` 作为依赖。代价:文件类型/日期变化不会立即重分组——但这两种属性在一次浏览会话中几乎不变,可接受。displayFileIds 变化(搜索/排序/翻页)仍会正确重分组。
2. 实施前需 Read useFileSearch.ts:167-185 确认 groupedFiles 的确切依赖数组行号。

### 改动 4:去掉 PC 分页

**文件**:[src/hooks/useFileSearch.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/hooks/useFileSearch.ts)(line 152-161)
**为什么**:前三项改动已消除逻辑层瓶颈,可安全去掉分页。
**怎么做**:
1. line 153 改为:
   ```ts
   const pageSize = allMatchingFileIds.length;
   ```
   即两端都全量(与安卓一致)。保留 pageSize 变量以避免下游引用报错。
2. line 157-161 的 displayFileIds useMemo 简化:
   ```ts
   const displayFileIds = useMemo(() => allMatchingFileIds, [allMatchingFileIds]);
   ```
   (isAndroid 分支可保留也可合并,行为一致。)
3. 分页 UI([App.tsx:2700, 2836-2856](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx) 的 PaginationControls)无需删除:`totalResults > pageSize` 条件自然为 false,UI 自动隐藏。保留代码以备未来需要。

### 次要项(分组组件 visibleItems)

**文件**:[src/components/FileGrid.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx)(line 734-738)
**说明**:分组视图下,每个 group 内部的 `GroupComponent` 也有 `layout.filter`(line 734)。单个 group 通常 < 1000 项,线性 filter 可接受。**本计划暂不优化**,若实测分组视图卡顿再处理。优先保证非分组视图(搜索浏览主场景)流畅。

## Assumptions & Decisions

1. **统一用 sortedByY + 二分**,不为 grid/list 单独写行号推算 O(1) 方案。理由:二分 O(log n) 对 9.8 万仅 17 次比较,已足够快;统一逻辑降低代码复杂度和维护成本。
2. **sortedByY 在主线程构建**,不在 worker 内构建。理由:worker 返回的 layout 是新数组,主线程排序一次 O(n log n) 约 5-10ms,低频可接受;若放 worker 需改 worker 协议,增加复杂度。
3. **postKey 用 djb2 hash**,不用抽样。理由:全量 hash O(n) 但纯数字运算,9.8 万约 1-2ms,比 join(生成 MB 字符串)快 5-10 倍;抽样有漏检风险,全量更可靠。
4. **groupedFiles 去掉 state.files 依赖**,接受文件类型/日期变化不立即重分组的代价。理由:这两种属性在一次浏览会话中几乎不变,而 state.files 引用变动频繁(缩略图 meta 更新等),收窄依赖收益远大于代价。
5. **保留分页 UI 代码**,仅改 pageSize 使其不触发显示。理由:代码无副作用,保留降低改动面,未来若需对超大集合重新启用分页可低成本恢复。
6. **不优化 layout worker 全量计算**(瓶颈 #4)。理由:仅在 thumbnailSize/containerWidth 变更时触发,低频;前 3 项改动后实测若可接受则不碰,避免增量 layout 的高复杂度。
7. **不优化 allMatchingFileIds 排序**(瓶颈 #5)。理由:已有 useMemo 缓存,只在搜索/排序条件变化时触发,非高频。

## Verification Steps

1. **构建验证**:`npm run build` 通过,无类型错误。
2. **PC 端搜索场景测试**(核心):
   - 打开包含约 9.8 万张图的图片库
   - 执行宽泛搜索(如按日期范围或空搜索),使结果返回数万项
   - 验证:无分页按钮显示,可一次性滚动到底
   - 滚动流畅度:用 DevTools Performance 录制滚动,确认帧率 ≥ 50fps,`visibleItems` useMemo 耗时 < 2ms
   - 检查 `window.__AURORA_RENDER_COUNTS__`:`fileGridTotal` ≈ 数万,`fileGrid`(visibleItems.length)保持 ~50-150,`fileGridVirtualizedLogical` = true
3. **各 layout 模式测试**:对同一批搜索结果切换 grid/list/masonry/adaptive,确认 4 种模式滚动均流畅,无可见项遗漏。
4. **缩略图缩放测试**:在数万结果上用 Ctrl+滚轮缩放,确认 layout 重算后(sortedByY 重建)滚动仍正常,FLIP 动画无异常。
5. **分组视图测试**:切换 groupBy=type/date,确认分组正常显示,每组可滚动(group 内 visibleItems 仍用线性 filter,但 group 较小应可接受)。
6. **Android 回归测试**:确认安卓端行为不变(本就不分页,改动 1/2 对安卓同样生效,应同样受益)。
7. **日志确认**:搜索浏览时无 `[useLayout] Posting to worker` 频繁刷屏;滚动时不出现长任务(Long Task > 50ms)。

## 实施顺序

1. 改动 2(useLayoutHook:sortedByY + postKey hash)— 先改 hook,提供 sortedByY
2. 改动 1(FileGrid:visibleItems 二分)— 依赖改动 2 的 sortedByY
3. 改动 3(groupedFiles 依赖收窄)
4. 改动 4(去掉 PC 分页)— 最后一步,前三项就绪后安全去除
5. 构建验证
