# 修复模型状态"加载中..."占位符问题

## 问题描述

在 AI 视觉设置面板中，当用户正在下载模型时，如果执行以下操作：
1. 切换设置栏目
2. 点击设置窗口的"完成"关闭设置
3. 重新打开设置并回到 AI 视觉页面

此时会出现问题：**所有模型（包括正在下载的、已下载的）都一直显示"加载中..."占位符，无法恢复正常显示。**

## 根本原因分析（基于日志分析）

从日志 `localhost-1771550203848.log` 可以看到：

```
1→ [AIVision] Loading model statuses..., isMounted: true
2→ [AIVision] Fetching status for ViT-B-32...
3→ [AIVision] Already loading, skipping...
4→ [AIVision] Already loading, skipping...
5→ [AIVision] Already loading, skipping...
6→ [AIVision] Status for ViT-B-32: {..., downloaded_size: 607968381, ...}
7→ [AIVision] Fetching status for ViT-L-14...
8→ [AIVision] Status for ViT-L-14: {..., downloaded_size: 0, ...}
...
12→ [AIVision] Setting isLoading to false, isMounted: true
13→ [AIVision] Loading model statuses..., isMounted: true  <-- 问题！这里又重新加载了
```

### 问题 1: 组件重新挂载时重复触发加载

`loadModelStatuses` 在以下情况会被调用：
- 组件挂载时（第 395-403 行的 useEffect）
- GPU 设置变更时（第 405-408 行的 useEffect）

当用户关闭设置再打开时，组件重新挂载，会再次触发加载。

### 问题 2: 状态未正确恢复

从日志可以看到：
- 第 12 行：`isLoading` 已经被设为 `false`
- 第 13 行：又重新开始了加载

这说明当组件重新挂载时，`modelStatuses` 状态被重置为空对象 `{}`，而 `isLoading` 又被设为 `true`，导致显示"加载中..."。

### 问题 3: 显示逻辑的判断条件

当前代码（第 780 行）：
```typescript
const isStatusLoading = isLoading && !status;
```

当 `isLoading = true` 且 `status = undefined`（因为 `modelStatuses` 被重置）时，就会显示"加载中..."

## 修复方案

### 方案 1: 使用全局状态保持模型状态（推荐）

创建全局状态来保持 `modelStatuses`，避免组件重新挂载时丢失：

```typescript
// 在 modelDownloadState.ts 中添加
export const globalModelStatusState: {
  statuses: Record<string, ClipModelStatus>;
  isLoaded: boolean;
  lastLoadTime: number;
} = {
  statuses: {},
  isLoaded: false,
  lastLoadTime: 0,
};

// 在 SettingsModal.tsx 中
useEffect(() => {
  // 如果全局状态已加载且未过期（5分钟内），直接使用
  if (globalModelStatusState.isLoaded && 
      Date.now() - globalModelStatusState.lastLoadTime < 5 * 60 * 1000) {
    setModelStatuses(globalModelStatusState.statuses);
    return;
  }
  
  loadModelStatuses();
}, []);

const loadModelStatuses = async () => {
  ...
  if (isMountedRef.current) {
    setModelStatuses(statuses);
    // 保存到全局状态
    globalModelStatusState.statuses = statuses;
    globalModelStatusState.isLoaded = true;
    globalModelStatusState.lastLoadTime = Date.now();
  }
};
```

### 方案 2: 优化显示逻辑

修改"加载中"的判断条件，使其更智能：

```typescript
// 当前逻辑
const isStatusLoading = isLoading && !status;

// 改进逻辑：只有当真正在加载且没有缓存的状态时才显示加载中
const isStatusLoading = isLoading && !status && !globalModelStatusState.statuses[model.name];
```

### 方案 3: 延迟加载状态显示

添加一个短暂的延迟，避免闪烁和过早显示"加载中"：

```typescript
const [showLoading, setShowLoading] = useState(false);

useEffect(() => {
  if (isLoading) {
    const timer = setTimeout(() => setShowLoading(true), 300);
    return () => clearTimeout(timer);
  } else {
    setShowLoading(false);
  }
}, [isLoading]);

const isStatusLoading = showLoading && !status;
```

### 方案 4: 使用 React.memo 或保持组件状态

如果 SettingsModal 是条件渲染的（`{isSettingsOpen && <SettingsModal ... />}`），可以考虑改为始终渲染但用 CSS 控制显示/隐藏，这样组件状态不会丢失。

但这种方式改动较大，建议优先使用方案 1。

## 建议的完整修复

综合以上分析，建议采用以下修复：

1. **添加全局状态缓存**（方案 1）- 避免组件重新挂载时丢失已加载的状态
2. **优化显示逻辑**（方案 2）- 使用全局缓存判断是否需要显示"加载中"
3. **添加加载延迟**（方案 3）- 避免闪烁

## 相关代码位置

- `src/components/SettingsModal.tsx` 第 512-548 行的 `loadModelStatuses` 函数
- `src/components/SettingsModal.tsx` 第 394-408 行的 `useEffect` 调用
- `src/components/SettingsModal.tsx` 第 780、836-839 行的显示逻辑
- `src/utils/modelDownloadState.ts` - 需要添加全局状态
