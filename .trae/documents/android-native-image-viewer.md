# 安卓端原生图片查看器（NativeGalleryView）实施计划

## 概要

在 `MainActivity` 中创建一个全屏 `NativeGalleryView`（基于 Coil + 自实现 `ZoomableImageView`），覆盖在 WebView 之上。当 Android 用户从网格视图打开图片时，前端通过 Tauri invoke 调用 `android_open_native_viewer` 把图片列表传给原生层，原生层用 Coil 加载 + BitmapFactory inBitmap 复用 + GPU 直接渲染，绕开 WebView 的 DOM/Layout/Paint 管线，达到接近原生相册的流畅度。

原生层包含完整的 UI（顶栏、缩略图条、信息浮层、双击缩放、滑动切换、幻灯片、旋转），高级功能（删除、AI 分析、对比、编辑标签）通过 `webView.evaluateJavascript` 调用 WebView 中预埋的桥接函数实现。WebView 端的 `ImageViewer` 在 Android 上不再渲染图片主体（避免双重视图）。

## 当前状态分析

### 现有 Android 原生层基础设施
- `MainActivity.kt` 已有 `generateImagePreview`（BitmapFactory + 降采样 + 缓存到 cacheDir）
- 已有 `findWebView(window.decorView)` 工具方法
- 已有 `setImmersiveMode`、`setStatusBarStyle`、`ColorExtractionService` 等基础设施
- `lib.rs` L1863 是 Android 命令注册区，已有 30+ 个 `android_*` 命令
- JNI 桥接模式：`ndk_context::android_context()` + `jni::JavaVM::from_raw` + `attach_current_thread` + `call_method`

### 当前 ImageViewer 的痛点（来自日志分析）
- `[ANIM] END 302.6ms` —— 写死的 280ms 动画窗口是主要感知延迟
- WebView 渲染管线：touchmove → React diff → DOM update → Layout → Paint → Composite，串行执行
- `<img>` 解码无法用 `inBitmap` 复用，大图每次切换都要重建 GPU texture
- 多层 img 同时存在（swipe-in/swipe-out/main/lan-thumb/outgoing）合成层压力

### LAN 图片支持
- `lanClientApi.getImageUrl(remotePath)` 返回完整 HTTP URL（含 token）
- `lanClientApi.getThumbnailUrl(remotePath)` 返回 256px 缩略图 URL
- 原生层用 OkHttp（Coil 默认底层）加载 LAN HTTP URL，自动复用 connection pool

## 实施方案

### 阶段 1：原生查看器骨架（核心图片浏览）

#### 1.1 添加依赖（`src-tauri/gen/android/app/build.gradle.kts`）
- 新增 Coil 2.x：`implementation("io.coil-kt:coil:2.7.0")`
- 新增 OkHttp 拦截器（用于 LAN token 鉴权）：`implementation("com.squareup.okhttp3:okhttp:4.12.0")`（Coil 传递依赖会带入，显式声明便于直接使用）
- 新增 RecyclerView 用于缩略图条：`implementation("androidx.recyclerview:recyclerview:1.3.2")`
- 新增 Kotlin Coroutines（Coil 已传递依赖）：`implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")`

#### 1.2 新增 `ZoomableImageView.kt`
**路径**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/ZoomableImageView.kt`

继承 `AppCompatImageView`，自实现手势：
- `ScaleGestureDetector` 处理 pinch-zoom（min=fit, max=8x）
- `GestureDetector` 处理双击（fit↔2x↔original 三档循环）、单击（通知父级切换沉浸）、长按
- 矩阵变换：`Matrix` 实现 scale + translate + rotate
- `VelocityTracker` + `Scroller` 实现 fling 滚动
- 滑动超出阈值时通知父级触发翻页（避免与 pan 冲突：scale=1 且 dx>threshold 时才翻页）
- `setRotation90()` 方法支持 90 度递增旋转
- 双指缩放期间禁用翻页手势

#### 1.3 新增 `NativeGalleryView.kt`
**路径**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt`

继承 `FrameLayout`，构造时：
- `ZoomableImageView`（主图层，zIndex=0）
- `ProgressBar`（加载指示器，zIndex=1，居中）
- `RecyclerView`（底部缩略图条，zIndex=2，横向，默认隐藏）
- `LinearLayout`（顶栏，zIndex=3，含关闭/上一张/下一张/信息/幻灯片/旋转/更多按钮，半透明黑底）
- `LinearLayout`（信息浮层 BottomSheet，zIndex=4，默认隐藏）

核心方法：
- `open(images: List<ImageItem>, startIndex: Int, options: Options)` —— 初始化列表，加载 startIndex
- `navigate(direction: Int)` —— 切换到上一张/下一张（150ms 滑动动画）
- `close()` —— 释放资源，隐藏视图
- `setSlideshow(enabled: Boolean)` —— 启动/停止幻灯片（`Handler.postDelayed`，间隔可配置）
- `setRotation(degrees: Int)` —— 旋转当前图片
- `preload(index: Int)` —— 用 Coil 预加载相邻 2 张到 memory cache

Coil 加载配置：
```kotlin
val imageLoader = ImageLoader.Builder(context)
    .memoryCache { MemoryCache.Builder(context).maxSizePercent(0.3).build() }
    .diskCache { DiskCache.Builder().directory(File(context.cacheDir, "coil_cache")).maxSizeBytes(200L * 1024 * 1024).build() }
    .crossfade(false)  // 自己控制动画
    .build()
```

加载策略：
- 本地图片：`LoadRequest.Builder().data(File(path))`，Coil 自动用 BitmapFactory + inSampleSize 降采样到目标尺寸
- LAN 图片：`LoadRequest.Builder().data(httpUrl).header("Authorization", "Bearer $token")`，通过自定义 `OkHttpClient`（携带 LAN token）
- 缩略图预览：先加载 256px thumbnail URL 到 ImageView（立即显示），同时加载原图，原图就绪后用 `TransitionDrawable` 渐变替换（300ms）

切换动画：
- 用 `ViewPropertyAnimator.animate(ZoomableImageView).translationXBy(...).setDuration(150).withEndAction { ... }` 实现 150ms 滑动
- 旧图滑出 + 新图滑入同时进行（用两个 ImageView 交替）
- 翻页期间禁用 pinch-zoom

事件回调（通过 `MainActivity.evaluateJs`）：
- `onNavigate(index)` —— 通知 WebView 当前图片索引变化
- `onClose()` —— 用户点了关闭按钮
- `onColorExtract(path, colors)` —— 颜色提取完成（调用 `ColorExtractionService`）
- `onSlideshowTick(index)` —— 幻灯片自动切换

#### 1.4 修改 `MainActivity.kt`
- `onCreate` 中创建 `NativeGalleryView`，调用 `window.decorView.addView(nativeGalleryView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))`，初始 `visibility = GONE`
- 新增方法（被 Rust 通过 JNI 调用）：
  - `fun openNativeViewer(imagesJson: String, startIndex: Int, optionsJson: String)` —— 解析 JSON，调用 `nativeGalleryView.open(...)`
  - `fun closeNativeViewer()` —— 调用 `nativeGalleryView.close()`
  - `fun nativeViewerNavigate(direction: Int)` —— direction=-1 上一张，1 下一张
  - `fun nativeViewerSetSlideshow(enabled: Boolean)`
  - `fun nativeViewerSetRotation(degrees: Int)`
  - `fun nativeViewerSetLanToken(token: String)` —— 设置 LAN 鉴权 token 给 OkHttp interceptor
- 新增 `evaluateJs(script: String)` 辅助方法：`findWebView(...)?.evaluateJavascript(script, null)`

#### 1.5 新增 Rust 命令（`src-tauri/src/lib.rs`）
在 `lib.rs` L1863 的 Android invoke_handler 区域新增 6 个命令，遵循 `android_get_native_preview` 的 JNI 桥接模板：
- `android_open_native_viewer(images: String, start_index: i32, options: String)`
- `android_close_native_viewer()`
- `android_native_viewer_navigate(direction: String)` —— "prev" / "next" / "random"
- `android_native_viewer_set_slideshow(enabled: bool)`
- `android_native_viewer_set_rotation(degrees: i32)`
- `android_native_viewer_set_lan_token(token: String)`

每个命令的 JNI 调用模式参考 `android_get_native_preview`（L1246-1313）：
```rust
let activity = ndk_context::android_context();
let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }?;
let mut env = vm.attach_current_thread()?;
let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };
env.call_method(&activity_obj, "openNativeViewer", "(Ljava/lang/String;ILjava/lang/String;)V", &[...])?;
```

注意：返回 `Result<(), String>`，参数中的 `images` 是 JSON 字符串，原生层用 `org.json.JSONArray` 解析。

#### 1.6 前端集成

**修改 `src/App.tsx`（L2547 附近）**
- 在 `ImageViewer` mount 时，检测 `isAndroidPlatformCached() && state.settings.android.useNativeViewer`（新增设置项，默认 `true`）
- 若启用：调用 `invoke('android_open_native_viewer', { images: serializeImages(), startIndex: ..., options: ... })`
- `serializeImages()` 把 `sortedFileIds.map(id => ({ path, name, width, height, type: 'local' | 'lan', remotePath? }))` 序列化为 JSON
- `options` 包含：`lanToken`（如有）、`slideshow`（是否自动启动幻灯片）、`startRotation`
- 监听 `android-native-viewer-event` 事件（通过 `listen()` from `@tauri-apps/api/event`），事件 payload 为 `{ type: 'close' | 'navigate' | 'color-extracted' | ..., data: ... }`，转发到对应回调

**修改 `src/components/ImageViewer.tsx`**
- 在 Android 启用原生查看器时，主图片渲染区（L2472-2668 的 `<div className="w-full h-full flex items-center justify-center ...">`）渲染为空 div（保留布局占位，避免侧栏/顶栏位移）
- 保留所有 UI 控件（顶栏、信息面板、设置面板等）的渲染逻辑，但它们在原生查看器激活时不显示（`display: none`）
- 保留所有事件监听器（键盘、滑动等），但忽略 Android 平台
- 添加 prop `nativeViewerActive?: boolean`，控制是否隐藏 WebView 内的图片渲染区

**新增设置项**：在 `src/types.ts` 的 `Settings` 类型中添加：
```typescript
android: {
  useNativeViewer: boolean;  // 默认 true
};
```
设置面板中添加开关，允许用户回退到 WebView 模式（用于调试和兼容性）。

#### 1.7 桥接函数（WebView 侧）
在 `src/App.tsx` 中预埋全局函数供原生层调用：
```typescript
useEffect(() => {
  if (!isAndroidPlatformCached()) return;
  (window as any).__androidViewerBridge = {
    deleteCurrent: (fileId: string) => handleAndroidDelete([fileId]),
    aiAnalyze: (fileId: string) => handleAIAnalysis([fileId]),
    copyToFolder: (fileId: string) => setState(s => ({ ...s, activeModal: { type: 'copy-to-folder', data: { fileIds: [fileId] } } })),
    moveToFolder: (fileId: string) => setState(s => ({ ...s, activeModal: { type: 'move-to-folder', data: { fileIds: [fileId] } } })),
    editTags: (fileId: string) => setState(s => ({ ...s, activeModal: { type: 'edit-tags', data: { fileId } } })),
    openInCompare: (fileId: string) => handleOpenCompareAndClearSelection([fileId]),
    closeNativeAndShowWebView: (fileId: string) => { /* 切换到 WebView 模式 */ },
  };
  return () => { delete (window as any).__androidViewerBridge; };
}, []);
```

### 阶段 2：高级功能与细节完善

#### 2.1 颜色提取集成
- 原生层切换图片时，调用 `ColorExtractionService.getDominantColors(path)` 异步提取颜色
- 提取完成后通过 `evaluateJs("window.__androidViewerBridge.onColorExtracted('$path', $colorsJson)")` 回传
- WebView 端把颜色写入 `paletteCache`，触发 `PALETTE_CACHE_UPDATE_EVENT` 让 MetadataPanel 更新

#### 2.2 信息浮层（BottomSheet）
- `NativeGalleryView` 内置 BottomSheet，显示：文件名、路径、尺寸（已旋转后的逻辑尺寸）、文件大小、拍摄时间、调色板色块
- 用户点击顶栏"信息"按钮 → BottomSheet 上滑显示
- 调色板通过 `ColorExtractionService` 获取（已有数据库缓存）

#### 2.3 缩略图条
- 底部横向 `RecyclerView`，每项 80x80dp，显示当前图片周围 ±20 张缩略图
- 用 Coil 加载 thumbnail（本地：`MediaStore.Images.Thumbnails`；LAN：256px HTTP URL）
- 点击跳转到对应图片
- 滑动时同步高亮当前项

#### 2.4 幻灯片模式
- 顶栏"幻灯片"按钮切换
- 启用时：隐藏顶栏/底栏，3 秒后自动进入沉浸模式（`setImmersiveMode(true)`）
- 切换间隔：5 秒（从 `state.slideshowConfig.interval` 读取，通过 options 传入）
- 过渡效果：fade（用 `AlphaAnimation` 300ms）或 slide（用 `TranslateAnimation` 200ms），从 `slideshowConfig.transition` 读取
- Ken Burns 效果：`ViewPropertyAnimator` 缓慢平移+缩放（10 秒周期）
- 点击屏幕任意位置退出幻灯片

#### 2.5 沉浸模式
- 单击切换顶栏/底栏显隐（`ViewPropertyAnimator.animate(topBar).translationYBy(...)`）
- 进入沉浸时调用 `MainActivity.setImmersiveMode(true)`
- 退出时恢复

#### 2.6 旋转
- 顶栏"旋转"按钮：`ZoomableImageView.setRotation90(currentRotation + 90)`
- 旋转后重新计算 fit scale
- 旋转状态通过 `onNavigate` 事件同步给 WebView（保存到 file metadata）

#### 2.7 LAN 图片支持
- 启动原生查看器时，前端通过 `android_native_viewer_set_lan_token` 传入 LAN token
- 原生层用自定义 `OkHttpClient` + `Interceptor` 自动给 `lan://` 开头的请求加 `Authorization: Bearer $token` 头
- 缩略图预加载：先加载 `getThumbnailUrl` 的 256px 图，原图加载完用 `TransitionDrawable` 渐变替换
- 网络异常时显示错误图标和重试按钮

#### 2.8 内存管理
- 监听 `ComponentCallbacks2.onTrimMemory`：低内存时清空 Coil memory cache
- 最多保留 6 张解码后的 Bitmap 在内存（Coil LRU 自动管理）
- 切换图片时，已离开视口 ±3 张之外的图片从 memory cache 移除
- 已有的 `memoryPressureLow/Critical` 机制复用

### 阶段 3：质量保证

#### 3.1 日志
- 在 `NativeGalleryView` 关键路径添加 `Log.d("NativeViewer", ...)` 日志：open/close/navigate/preload/cache hit/miss
- 复用现有 `[PERF]` 日志格式，便于和 WebView 模式对比

#### 3.2 测试用例
- 本地图片切换（连续滑动 20 张，无 OOM）
- 大图（4K+）pinch-zoom（流畅 60fps）
- GIF/动画 WebP 播放
- LAN 图片加载（含 token 鉴权）
- 幻灯片模式（fade + slide 两种过渡）
- 旋转后切换图片（旋转状态正确重置）
- 沉浸模式进出（系统 UI 显隐正确）
- 内存压力测试（连续切换 200 张，监控内存）

#### 3.3 回退方案
- 设置项 `useNativeViewer` 默认 `true`，用户可关闭回到 WebView 模式
- 原生层初始化失败时（如 Coil 加载失败），自动调用 `closeNativeViewer` 并回退到 WebView
- 在 `openNativeViewer` 调用失败时，前端捕获异常并显示 WebView 模式的 ImageViewer

## 关键文件改动清单

### 新增文件
1. `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/ZoomableImageView.kt`（~400 行）
2. `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt`（~600 行）
3. `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/ThumbnailStripAdapter.kt`（~150 行）
4. `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/InfoBottomSheet.kt`（~200 行）

### 修改文件
1. `src-tauri/gen/android/app/build.gradle.kts` —— 新增 Coil/RecyclerView/Coroutines 依赖
2. `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt` —— 新增 6 个方法、onCreate 中创建 NativeGalleryView
3. `src-tauri/src/lib.rs` —— 新增 6 个 `android_native_viewer_*` Tauri 命令（L1863 区域）
4. `src/App.tsx` —— ImageViewer mount 时调用原生层、监听原生事件、预埋 `__androidViewerBridge`
5. `src/components/ImageViewer.tsx` —— Android 启用原生层时隐藏 WebView 内图片渲染
6. `src/types.ts` —— 新增 `android.useNativeViewer` 设置项
7. `src/components/SettingsPanel.tsx`（或对应文件）—— 新增"使用原生查看器"开关

## 假设与决策

### 假设
1. 设备最低 API 24（minSdk 已配置），Coil 2.x 支持 API 21+
2. Coil 默认使用 BitmapFactory 解码，对于 4K+ 大图会自动降采样到屏幕尺寸 1.5x，避免 OOM（不需要 tile-based 解码）
3. LAN token 通过 `android_native_viewer_set_lan_token` 命令传递，OkHttp Interceptor 自动加到所有 `lan://` 请求
4. 用户不需要在原生查看器中看到 AI 分析结果详情，AI 分析触发后切换到 WebView 模式查看结果

### 决策
1. **不使用 SubsamplingScaleImageView**：增加额外依赖且不支持 GIF/动画 WebP。Coil 的降采样足够避免 OOM，pinch-zoom 到 8x 已经够用。
2. **不实现 tile-based 解码**：4K 图降采样到 2560x1440 后内存约 14MB（ARGB_8888），8 张约 112MB，在 4GB+ 内存的现代手机上安全。
3. **保留 WebView 的 ImageViewer 代码**：作为回退方案，不删除。仅在 Android 启用原生层时跳过图片渲染。
4. **UI 完全在原生层**：避免 WebView/原生层 z-index 冲突。高级功能通过 `evaluateJavascript` 调用 WebView 桥接函数。
5. **切换动画 150ms**：接近原生相册（100-150ms），比当前 WebView 的 280ms 快一倍。
6. **缩略图预加载策略**：当前 ±1 张立即加载，±2-3 张低优先级预加载（复用现有策略，但由原生层 Coil 实现）。

## 验证步骤

1. **构建验证**：`cargo build --target aarch64-linux-android` + `cd src-tauri && cargo tauri android build` 成功
2. **功能验证**（每项需要在真机测试）：
   - 打开图片 → 原生层立即显示，无延迟
   - 左右滑动切换 → 150ms 内完成，无卡顿
   - 双击缩放 → 流畅过渡
   - pinch-zoom → 60fps
   - 旋转 → 矩阵正确
   - 幻灯片 → 自动切换 + Ken Burns
   - LAN 图片 → 加载成功 + token 鉴权通过
   - 关闭 → 正确退出，无内存泄漏
3. **性能对比**：
   - 用 `adb logcat | grep PERF` 对比 WebView 模式和原生模式的切换耗时
   - 原生模式预期：触摸到显示 < 50ms（vs WebView 300ms）
4. **内存测试**：
   - 连续切换 200 张 4K 图片，监控 `adb shell dumpsys meminfo com.aurora.gallery`
   - 内存应稳定在 200MB 以下，无持续增长
5. **回退测试**：
   - 关闭 `useNativeViewer` 设置 → 回到 WebView 模式，所有功能正常
   - 原生层加载失败 → 自动回退到 WebView 模式

## 实施顺序（推荐）

1. 添加 Gradle 依赖，验证 Coil 能在项目中正常加载图片（最小 PoC）
2. 实现 `ZoomableImageView`，独立测试手势
3. 实现 `NativeGalleryView` 骨架（无 UI，只有图片 + 切换）
4. Rust 命令 + 前端 invoke 链路打通（能从 WebView 打开原生层）
5. 加入切换动画 + 预加载
6. 加入顶栏 + 关闭/上一张/下一张按钮
7. 加入缩略图条 + 信息浮层
8. 加入幻灯片 + 旋转
9. 加入 LAN 支持
10. 加入颜色提取桥接
11. 设置项 + 回退方案
12. 真机测试 + 性能调优
