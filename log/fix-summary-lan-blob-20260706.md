# LAN 图片查看器修复总结（2026-07-06）

## 问题描述

Android 端 LAN 图片查看器切换图片时，出现长时间黑屏/旧图残留（5-15 秒）。文件名已更新但图片长时间不更新。

## 根因分析

通过添加 7 组 PERF 生命周期日志，定位到瓶颈在 `response.blob()`：

```
[PERF] [LOAD] FETCH END 014_1_14.jpg 310ms          ← fetch 很快
[PERF] [LOAD] BLOB START 014_1_14.jpg 310ms
[PERF] [LOAD] BLOB END 014_1_14.jpg 5071ms           ← response.blob() 耗时 4.7 秒！
[PERF] [LOAD] OBJECT URL END 014_1_14.jpg 5074ms     ← URL.createObjectURL() 只需 2ms
```

在 Android WebView 中，`response.blob()` 对 3-4MB 的 LAN 图片耗时 5-8 秒，而 `fetch` 本身只需 300-1000ms。

## 已完成修改

### 文件：`src/components/ImageViewer.tsx`

#### 1. `loadToCache` LAN 分支（第 154-172 行）

**修改前**（约 60 行）：
```typescript
if (path.startsWith('lan://')) {
  const remotePath = path.slice('lan://'.length);
  const httpUrl = lanClientApi.getImageUrl(remotePath);
  const fileName = remotePath.split('/').pop() || remotePath;
  const controller = new AbortController();
  lanLoadEntries.set(path, { controller, t0: performance.now() });
  // ... fetch + AbortController + response.blob() + URL.createObjectURL()
  const response = await fetch(httpUrl, { signal: controller.signal });
  const blob = await response.blob();  // ← 瓶颈：5-8 秒
  const blobUrl = URL.createObjectURL(blob);
  blobCache.set(path, blobUrl);
  // ...
}
```

**修改后**（直接缓存 HTTP URL，跳过 blob fetch）：
```typescript
if (path.startsWith('lan://')) {
  const remotePath = path.slice('lan://'.length);
  const httpUrl = lanClientApi.getImageUrl(remotePath);
  const fileName = remotePath.split('/').pop() || remotePath;

  const t0 = performance.now();
  blobCache.set(path, httpUrl);
  blobCacheSizes.set(path, 0);
  evictBlobCache();
  const cacheCount = blobCache.size;
  const cacheMemoryMB = (totalBlobBytes / 1024 / 1024).toFixed(1);
  PERF.log('[CACHE] CACHE INSERT (LAN HTTP URL)', fileName, 'count=' + cacheCount, 'memory=' + cacheMemoryMB + 'MB');
  loadLog('LOAD START + END (LAN, skipped blob fetch)', fileName, t0, 'priority=' + priority + ' HTTP URL cached directly');
  return httpUrl;
}
```

#### 2. 删除死代码

由于 LAN 分支现在同步返回（不再使用 fetch + AbortController），以下代码不再被使用，已删除：

- `LanLoadEntry` 接口（原第 120 行）
- `lanLoadEntries` Map（原第 121 行）— AbortController 追踪
- `highPriorityLoadPath` 变量（原第 125 行）— 阻止预加载的标志
- `cancelAllLanPreloads` 函数（原第 131-148 行）— 从未被调用
- `preloadToCache` 中的 `highPriorityLoadPath` 检查块（原第 273-279 行）

## 当前状态

- `npx tsc --noEmit` 通过
- `npm run build` 通过（仅有已有的非阻塞警告）
- Android7.log 验证：`response.blob()` 瓶颈已消除

```
[PERF] [CACHE] CACHE INSERT (LAN HTTP URL) ...063.jpg count=30 memory=0.0MB
[PERF] [LOAD] LOAD START + END (LAN, skipped blob fetch) ...063.jpg 0.0ms priority=low HTTP URL cached directly
```

## 未解决问题（下个会话重点）

### 新瓶颈：DECODE 阶段耗时 3.2 秒

从 Android7.log 第 52-66 行（SWITCH#70）：

```
02:51:56.504  [SWITCH#70] SWITCH START ...067.jpg 0.0ms
02:51:56.504  [SWITCH#70] CACHE LOOKUP ...067.jpg 0.1ms HIT
02:51:56.506  [SWITCH#70] DISPLAY SOURCE: CACHE ...067.jpg
02:51:56.507  [SWITCH#70] DECODE START ...067.jpg 0.1ms
02:51:58.003  [ANIM] END ...067.jpg 1501.6ms reason=MAX_WAIT     ← 动画超时
02:51:59.693  [SWITCH#70] DECODE END ...067.jpg 3190.5ms          ← 解码 3.2 秒！
02:51:59.694  [SWITCH#70] DISPLAY ...067.jpg 3191.0ms
```

**根因**：缓存命中后返回 HTTP URL，但 `<img>` 标签仍需从 HTTP URL 下载完整图片数据（3-4MB）并解码。缓存 HTTP URL 只是跳过了 `response.blob()` 转换，但实际的图片下载+解码仍发生在 `<img>` 的 DECODE 阶段。

SWITCH#69 同样：DECODE END 3201.1ms。

### 可能的解决方向

1. **真正缓存 blob 数据**：用其他方式获取图片数据并缓存为 blob URL（例如用 Tauri 的 Rust 后端下载，或用 `XMLHttpRequest` 替代 `fetch().blob()`）
2. **服务端生成缩略图/预览图**：LAN 服务器返回降采样预览图（类似本地 `android_get_native_preview`），减少传输+解码数据量
3. **解码优化**：研究 Android WebView 的图片解码性能，考虑用 `createImageBitmap` 或其他 API
4. **动画策略调整**：DECODE 耗时 3.2 秒时，动画在 1500ms MAX_WAIT 超时结束，但图片 3190ms 才显示 — 用户看到 1.7 秒空白。可能需要调整动画策略或预加载时机

## 关键代码位置参考

- `loadToCache` 函数：`src/components/ImageViewer.tsx` 第 122 行
- `preloadToCache` 函数：`src/components/ImageViewer.tsx` 第 243 行
- `getBlobCacheSync` 函数：`src/components/ImageViewer.tsx` 第 62 行
- `evictBlobCache` 函数：`src/components/ImageViewer.tsx` 第 42 行
- `loadLog` 日志辅助函数：`src/components/ImageViewer.tsx` 第 112 行
- `lcLog` 生命周期日志函数：`src/components/ImageViewer.tsx` 第 104 行
- `file.path` useEffect（SWITCH 生命周期）：搜索 `SWITCH START` 或 `lcLog`
- 动画清理 useEffect：搜索 `[ANIM] START` 或 `swipeAnimTimerRef`
- `preloadImages` useMemo：搜索 `PRELOAD QUEUE`
- `getAdjacentImageUrl`：搜索此函数名

## 日志格式说明

### 生命周期日志（SWITCH）
```
[PERF] [SWITCH#N] STEP fileName elapsedMs [extra]
```
步骤：SWITCH START → CACHE LOOKUP → DISPLAY SOURCE → DECODE START → DECODE END → DISPLAY

### 加载日志（LOAD）
```
[PERF] [LOAD] STEP fileName elapsedMs [extra]
```
步骤：LOAD START → FETCH START → FETCH END → CACHE INSERT → LOAD END

### 其他
- `[CACHE] CACHE INSERT` — 缓存插入
- `[ANIM] START/END` — 滑动动画
- `[PRELOAD] QUEUE` — 预加载队列
- `[ABORT] REQUEST ABORT` — 请求取消（已删除相关代码）

## 历史问题修复记录

1. LAN 大图滑动卡住 — `loadToCache` fetch blob + 滑动动画等待（已解决）
2. 红色错误日志 — `getDominantColors` 跳过 LAN 路径（已解决）
3. 主色调传输 — `ColorDbPool` + `BrowseItem.palette` 字段（已解决）
4. 图片切换"弹回来" — `getAdjacentImageUrl` 返回 fallback URL + 路径匹配替代 URL 匹配（已解决）
5. 快速切换卡顿 — `MAX_WAIT` 从 5000ms 降到 1500ms（已解决）
6. 预加载竞争带宽 — `AbortController` + `cancelAllLanPreloads` + `highPriorityLoadPath`（已删除，因 LAN 分支同步返回不再需要）
7. `response.blob()` 缓慢（5-8秒）— LAN 图片直接缓存 HTTP URL，跳过 blob fetch（已解决）
8. **DECODE 阶段 3.2 秒** — 未解决（下个会话重点）
