# 移除 ImageViewer 中的 Android 适配代码并屏蔽安卓端渲染

## Summary

Android 端已集成高性能原生 `NativeGalleryView`，`src/components/ImageViewer.tsx` 中原先为 Android 适配的所有代码（触摸手势、PERF 日志、native preview 加载、沉浸模式、分享按钮、专用图片变换计算等）不再需要。本次改动将：
1. 从 `ImageViewer.tsx` 中彻底移除所有 Android 专用代码，使其成为纯 PC 版图片查看器
2. 在 `App.tsx` 中将渲染条件改为 `!isAndroidSync()`，确保 Android 端永不渲染该组件
3. 移除 `useNativeViewer` 用户设置项（Android 强制使用原生查看器，无需开关）
4. 移除 `nativeViewerActive` prop（ImageViewer 被屏蔽后成为死代码）

## Current State Analysis

### ImageViewer.tsx 现状（~3015 行）
- 47+ 处 `isAndroidPlatformCached()` 调用
- Android 专用代码块包括：
  - 缓存大小动态计算（`MAX_ANDROID_CACHE_SIZE`、`getAndroidMaxCacheSize`）
  - PERF 日志系统（`PERF`、`lcLog`、`loadLog`、`switchSeq`）
  - `android_get_native_preview` 加载分支
  - Android idle 预加载逻辑
  - `android_pause/resume_thumbnail_workers` 调用
  - `containerSize`/`imgNaturalSize` 状态（仅 Android 变换计算使用）
  - pinch-zoom 双指缩放触摸处理
  - 单指拖拽/滑动翻页触摸处理（`swipeState`、`swipeOffset`、`getAdjacentImageUrl`）
  - `android-back-press` 事件监听
  - `setAndroidImmersiveMode`/`setAndroidStatusBar` 调用
  - Android 分享按钮（`android_share_image`）
  - Android 专用顶栏按钮组
  - `outgoingUrl` 淡出过渡（仅 Android 触发）
  - Android 专用图片渲染样式（`willChange`、`contain`、`backfaceVisibility`、`decoding: 'async'`）
  - Android 专用 transform 计算（`top-0 left-0` + `objectFit: 'fill'`）
  - `nativeViewerActive` prop 使用（2 处）
  - 上下文菜单 Android 样式分支（`isAndroid` 变量及多处条件）
  - 导航箭头 `!isAndroidPlatformCached()` 守卫

### App.tsx 现状
- 行 2350：`const useNativeViewer = isAndroidPlatformCached() && (state.settings.android?.useNativeViewer ?? true);`
- 行 2770：渲染条件 `activeTab.viewingFileId && !useNativeViewer`
- 行 2807：向 ImageViewer 传递 `nativeViewerActive={nativeViewerActive}`
- 原生查看器集成代码（行 2349-2555）仍需保留，Android 端依赖它

### 其他文件现状
- `src/types.ts` 行 351-353：`android?.{ useNativeViewer: boolean }` 接口定义
- `src/App.tsx` 行 156-158：默认设置 `android: { useNativeViewer: true }`
- `src/components/SettingsModal.tsx` 行 2561-2577：Android 原生查看器开关 UI
- `src/utils/translations.ts` 行 466-467、1393-1394：`useNativeViewer`/`useNativeViewerDesc` 翻译键

## Proposed Changes

### 文件 1: `src/components/ImageViewer.tsx`（主要清理）

**1.1 清理 imports（行 6）**
- 移除 `isAndroidPlatformCached, getGlobalCacheRoot, setAndroidImmersiveMode, androidShareImage, setAndroidStatusBar`
- 保留 `invoke, convertFileSrc`（PC 仍需使用）
- 若 `invoke` 在清理后仅用于 jxl/avif 预览，则保留

**1.2 移除 Android 缓存大小逻辑（行 22-37）**
- 删除 `MAX_ANDROID_CACHE_SIZE`、`getAndroidMaxCacheSize`
- 简化 `getMaxCacheSize` 为直接返回 `MAX_CACHE_SIZE`（或内联删除该函数，`evictBlobCache` 直接用 `MAX_CACHE_SIZE`）

**1.3 移除 PERF 日志系统（行 84-117）**
- 删除 `PERF` 对象、`switchSeq`、`lcLog`、`loadLog`
- 删除所有 `PERF.log`、`PERF.mark`、`PERF.measure`、`PERF.ms` 调用
- 删除所有 `lcLog`、`loadLog` 调用

**1.4 简化 `loadToCache`（行 167-283）**
- 删除 `isAndroidPlatformCached()` 分支（行 227-261，`android_get_native_preview` 调用）
- 保留 LAN HTTP URL 缓存分支（行 175-192，PC 也会浏览 LAN 图片）
- 保留 jxl/avif 预览分支
- 保留 `convertFileSrc` fallback

**1.5 简化 `preloadToCache`（行 291-313）**
- 删除 `isAndroidPlatformCached()` 条件分支（idle callback 逻辑）
- 简化为直接 `loadToCache(path, priority).catch(() => {})`

**1.6 移除 `nativeViewerActive` prop**
- 从 `ViewerProps` 接口删除 `nativeViewerActive?: boolean`（行 459）
- 从解构参数删除 `nativeViewerActive = false`（行 507）
- 删除行 2468 的 `!nativeViewerActive` 条件
- 删除行 2479 的 `nativeViewerActive ? { display: 'none' } : {}` 条件

**1.7 移除 Android 专用 viewer 生命周期钩子（行 734-745）**
- 删除 `android_pause_thumbnail_workers`/`android_resume_thumbnail_workers` 调用

**1.8 移除 `containerSize`/`imgNaturalSize` 状态**
- 删除 `imgNaturalSize` state（行 620）及其在 `preloadImg.onload` 中的 `setImgNaturalSize` 调用
- 删除 `containerSize` state（行 621）
- 删除 `containerSize` 测量 useEffect（行 1230-1241）
- 删除 `useLayoutEffect` 中的 `setContainerSize` 调用（行 1247）
- 删除 `immersiveFlip` 中对 `containerRef` 的 `getBoundingClientRect` 及 `setContainerSize`（行 1244-1248）

**1.9 移除 pinch-zoom 触摸处理（行 1394-1409、1455-1562）**
- 删除第一个空的 pinch-zoom useEffect（行 1394-1409）
- 删除第二个完整的 pinch-zoom useEffect（行 1455-1562）

**1.10 移除单指拖拽/滑动翻页触摸处理（行 1564-1821）**
- 删除整个单指触摸 useEffect
- 删除相关状态：`swipeState`、`isSwiping`、`swipeOffset`、`swipeStateRef`、`swipeOutImgRef`、`swipeInImgRef`、`swipeAnimTimerRef`
- 删除 `getAdjacentImageUrl` 函数（行 1411-1453，仅滑动翻页使用）
- 删除 swipe 动画结束检测 useEffect（行 767-799）

**1.11 移除 `outgoingUrl` 淡出过渡（Android 专用）**
- 删除 `outgoingUrl`、`outgoingUrlRef`、`outgoingFadeTimerRef` 状态（行 722-724）
- 删除所有 `setOutgoingUrl`/`outgoingUrlRef.current` 赋值（行 906-910、931-935、997-1001、1040-1044）
- 删除 `outgoingUrl` 渲染分支（行 2563-2581）
- 删除 `onLoad` 中的 `outgoingUrl` 清理逻辑（行 2610-2617）

**1.12 移除 `android-back-press` 事件监听（行 1899-1911）**
- 删除整个 useEffect

**1.13 简化 `toggleImmersiveMode`（行 1845-1894）**
- 移除 `isAndroidPlatformCached()` 分支（`setAndroidImmersiveMode`/`setAndroidStatusBar` 调用）
- 保留 PC 的 `requestFullscreen`/`exitFullscreen` 逻辑

**1.14 简化 `stopSlideshow`（行 2074-2097）**
- 移除 `isAndroidPlatformCached()` 分支
- 保留 PC 的 `document.exitFullscreen` 逻辑
- 移除 `setAndroidStatusBar` 调用

**1.15 简化 `toggleSlideshow`（行 2099-2121）**
- 移除 `isAndroidPlatformCached()` 分支
- 保留 PC 的 `requestFullscreen` 逻辑

**1.16 简化 fullscreenchange 监听（行 2124-2137）**
- 移除 `!isAndroidPlatformCached()` 守卫（直接执行 PC 逻辑）

**1.17 移除 `enterImmersiveOnMount` prop**
- 从 `ViewerProps` 接口删除 `enterImmersiveOnMount?: boolean`（行 458）
- 从解构参数删除 `enterImmersiveOnMount = false`（行 506）
- 删除 `autoImmersiveDoneRef` 及对应 useEffect（行 1913-1921）
- 注意：App.tsx 行 2806 传递的 `enterImmersiveOnMount={state.settings.openInImmersiveByDefault}` 也需同步移除

**1.18 简化顶栏按钮组（行 2261-2269、2387-2442）**
- 移除 `{!isAndroidPlatformCached() && (...)}` 守卫，始终显示前进按钮（行 2261-2269）
- 删除 Android 专用按钮组（行 2387-2417）：1:1 切换、旋转、分享、删除、更多按钮
- 保留 PC 按钮组（行 2418-2442）：1:1、fit、左旋、右旋、搜索

**1.19 简化容器样式（行 2458-2465）**
- 移除 `isAndroidPlatformCached() ? { contain: 'layout paint style' } : {}`
- 移除 `onContextMenu={isAndroidPlatformCached() ? ... : handleContextMenu}`，直接用 `handleContextMenu`

**1.20 简化图片渲染样式**
- 移除所有 `isAndroidPlatformCached() ? { willChange: ..., contain: ..., backfaceVisibility: ... } : {}`（行 2478、2528、2556、2577、2598、2669）
- 移除所有 `decoding={isAndroidPlatformCached() ? 'async' : 'sync'}`，改为 `decoding="sync"`（行 2519、2547、2632）
- 移除 `isAndroidPlatformCached() && imgNaturalSize && containerSize` 三元分支（行 2624-2666），保留 PC 分支（`width: '100%'`, `height: '100%'`, `objectFit: 'contain'`, `transform` 计算）
- 移除 `onError` 中的 `isAndroidPlatformCached()` 守卫（行 2620-2623），直接删除 onError 或保留简单日志

**1.21 移除导航箭头守卫（行 2676）**
- 移除 `!isAndroidPlatformCached()` 条件，始终显示左右导航箭头

**1.22 简化上下文菜单（行 2698-2908）**
- 移除 `const isAndroid = isAndroidPlatformCached()`（行 2699）
- 移除所有 `isAndroid ? ... : ...` 三元分支，统一使用 PC 样式
- 移除所有 `!isAndroid && (...)` 守卫，始终显示对应菜单项（原始尺寸、适应窗口、在资源管理器中显示、复制图片、删除）
- 移除 Android 专用菜单项样式（`height: '50px'`、`fontSize: '15px'`）
- 统一 `menuItemClass`、`deleteItemClass`、`purpleItemClass`、`iconSize` 为 PC 值

**1.23 清理未使用的 imports**
- 移除 `usePinchZoom`（行 9，若未在其他地方使用）
- 移除未使用的 lucide 图标（`Share2`、`MoreVertical` 等 Android 专用图标）
- 移除 `useLayoutEffect`（若 `immersiveFlip` 简化后不再需要）

### 文件 2: `src/App.tsx`

**2.1 移除 `useNativeViewer` 设置变量（行 2350）**
- 将 `const useNativeViewer = isAndroidPlatformCached() && (state.settings.android?.useNativeViewer ?? true);`
- 改为 `const useNativeViewer = isAndroidPlatformCached();`（Android 强制使用原生查看器）
- 保留 `useNativeViewer` 变量名以最小化对原生查看器集成代码（行 2349-2555）的影响

**2.2 修改 ImageViewer 渲染条件（行 2770）**
- 将 `{activeTab.viewingFileId && !useNativeViewer && (`
- 改为 `{activeTab.viewingFileId && !isAndroidSync() && (`

**2.3 移除 `nativeViewerActive` prop 传递（行 2807）**
- 删除 `nativeViewerActive={nativeViewerActive}` 这一行
- 保留 App.tsx 内部的 `nativeViewerActive` state（原生查看器集成仍需要）

**2.4 移除 `enterImmersiveOnMount` prop 传递（行 2806）**
- 删除 `enterImmersiveOnMount={state.settings.openInImmersiveByDefault}` 这一行

**2.5 移除默认设置中的 `useNativeViewer`（行 156-158）**
- 将 `android: { useNativeViewer: true },` 改为 `android: {},` 或完全移除 `android` 字段
- 注意：需检查 `android` 字段是否有其他子字段，若无则移除整个 `android` 字段

### 文件 3: `src/types.ts`

**3.1 移除 `useNativeViewer` 接口字段（行 351-353）**
- 将 `android?: { useNativeViewer: boolean; }` 改为 `android?: {}` 或完全移除 `android` 字段
- 若移除整个 `android` 字段，需同步清理所有 `state.settings.android` 引用

### 文件 4: `src/components/SettingsModal.tsx`

**4.1 移除原生查看器开关 UI（行 2561-2577）**
- 删除整个 `{isAndroid && (...)}` 块（原生查看器开关 toggle）
- 保留前后的其他设置项

### 文件 5: `src/utils/translations.ts`

**5.1 移除翻译键**
- 删除行 466-467（中文）：`useNativeViewer`、`useNativeViewerDesc`
- 删除行 1393-1394（英文）：`useNativeViewer`、`useNativeViewerDesc`

## Assumptions & Decisions

1. **LAN 图片相关代码保留**：`lanThumbUrl`、`lanFadeIn`、`preloadedImages`、`preloadLanImage` 等 LAN 图片处理逻辑不是 Android 专用，PC 也会浏览 LAN 图片，全部保留。

2. **`useNativeViewer` 变量保留为 `isAndroidPlatformCached()` 别名**：为最小化对 App.tsx 原生查看器集成代码（~200 行）的影响，保留该变量名但简化其赋值。原生查看器集成代码本身（invoke `android_open_native_viewer` 等）完全保留不动。

3. **`nativeViewerActive` state 保留在 App.tsx**：原生查看器集成代码仍需该状态来决定是否向原生层推送更新（行 2534），仅移除向 ImageViewer 传递的 prop。

4. **`enterImmersiveOnMount` prop 移除**：该 prop 用于 ImageViewer 挂载时自动进入沉浸模式，但 Android 端不再渲染 ImageViewer，PC 端的沉浸模式由用户手动触发或通过 `openInImmersiveByDefault` 设置控制。由于该功能在 PC 端也未被积极使用且增加了复杂度，一并移除。若用户后续需要 PC 端自动沉浸，可重新实现。

5. **Android 端无回退**：移除 `useNativeViewer` 设置后，Android 端强制使用原生查看器，无 WebView 回退。这符合用户意图（"安卓端需要屏蔽掉这个组件"）。

6. **触摸手势全部移除**：pinch-zoom、单指拖拽平移、滑动翻页等触摸手势全部移除。PC 版使用鼠标滚轮缩放、鼠标拖拽平移、左右导航按钮翻页。

7. **`isAndroidPlatformCached` 等 tauri-bridge 函数不删除**：这些函数在其他文件（ImageComparer、AppModals、SettingsModal 等）中仍有使用，仅移除 ImageViewer.tsx 中的引用。

## Verification Steps

1. **TypeScript 编译检查**：运行 `npm run build` 或 `tsc --noEmit`，确保无类型错误（特别检查未使用的变量、缺失的 props）

2. **PC 端功能验证**：
   - 打开图片查看器，确认图片正常显示
   - 鼠标滚轮缩放正常
   - 鼠标拖拽平移正常
   - 左右导航按钮翻页正常
   - 上下文菜单（右键）所有菜单项正常显示
   - 幻灯片模式启动/停止正常
   - 沉浸模式（fullscreen）切换正常
   - LAN 图片浏览及缩略图渐变正常

3. **Android 端验证**：
   - 确认点击图片后调用原生 NativeGalleryView（非 WebView ImageViewer）
   - 设置页面不再显示"使用原生查看器"开关
   - 原生查看器的所有功能（滑动翻页、抽屉、缩放等）正常

4. **代码搜索验证**：
   - 在 `src/components/ImageViewer.tsx` 中搜索 `isAndroidPlatformCached`，应返回 0 结果
   - 在 `src/components/ImageViewer.tsx` 中搜索 `isAndroid`、`android`，应仅剩注释或无结果
   - 在 `src/App.tsx` 中搜索 `nativeViewerActive`，应仅在原生查看器集成代码中出现，不在 ImageViewer props 中出现
   - 在整个 `src/` 中搜索 `useNativeViewer`，应仅在 `types.ts`（若保留空 android 字段）或完全无结果

5. **设置面板验证**：
   - PC 端打开设置，确认无"使用原生查看器"选项
   - Android 端打开设置，确认无"使用原生查看器"选项
