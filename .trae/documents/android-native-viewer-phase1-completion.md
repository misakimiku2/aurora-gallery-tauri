# 安卓原生图片查看器 Phase 1 收尾计划

## 概要

本计划聚焦于完成安卓原生图片查看器（方案 C）Phase 1 的前端集成工作。Phase 1 的原生层（Kotlin）、Rust 命令、类型定义、App.tsx 集成主体已基本完成，但存在以下遗留问题需要修复：

1. App.tsx 中 3 处变量名 Bug（导致编译失败 / 运行时无效依赖）
2. ImageViewer.tsx 未接收 `nativeViewerActive` prop，未在原生层激活时隐藏 WebView 图片渲染区
3. App.tsx 中 `<ImageViewer>` 元素未传递 `nativeViewerActive` prop
4. SettingsModal.tsx 缺少"使用原生查看器"开关（用户回退方案）
5. 构建验证（tsc / vite build / cargo check）

设计文档参见 [android-native-image-viewer.md](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/.trae/documents/android-native-image-viewer.md)。

## 当前状态分析

### 已完成（无需修改）

| 项 | 文件 | 状态 |
|---|---|---|
| Gradle 依赖（Coil 2.7.0 / RecyclerView / Coroutines） | `src-tauri/gen/android/app/build.gradle.kts` | ✅ |
| ZoomableImageView.kt（~400 行，手势/缩放/旋转） | `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/ZoomableImageView.kt` | ✅ |
| NativeGalleryView.kt（~1200 行，完整 UI） | `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt` | ✅ |
| ThumbnailStripAdapter.kt（~150 行） | `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/ThumbnailStripAdapter.kt` | ✅ |
| MainActivity.kt 6 个公开方法 + setupNativeGalleryView() | `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt` L114-164 | ✅ |
| lib.rs 6 个 Tauri 命令 + invoke_handler 注册 | `src-tauri/src/lib.rs` | ✅ |
| types.ts `android.useNativeViewer` 字段 | [types.ts L351-353](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/types.ts#L351-L353) | ✅ |
| App.tsx 默认设置 `useNativeViewer: true` | [App.tsx L157](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L157) | ✅ |
| App.tsx 原生查看器集成主体 | [App.tsx L2349-2495](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2349-L2495) | ⚠️ 有 Bug |

### 已确认的导入（无需新增）

- [App.tsx L28](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L28)：`isAndroidPlatformCached` 已从 `./api/tauri-bridge` 导入
- [App.tsx L29](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L29)：`FileType` 已从 `./types` 导入
- [App.tsx L295](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L295)：`lanConnected` useState 已存在
- ImageViewer.tsx 已导入 `isAndroidPlatformCached`（L2475 已使用）

### 待修复 Bug（App.tsx L2349-2495）

#### Bug 1：`state.slideshowConfig.intervalMs` 不存在
- 位置：[App.tsx L2402](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2402) 和 [App.tsx L2420](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2420)
- 现状：`state.slideshowConfig.intervalMs || 5000`
- 类型定义：[types.ts L184](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/types.ts#L184) `SlideshowConfig.interval: number`（字段名是 `interval`，不是 `intervalMs`）
- 修复：改为 `state.slideshowConfig.interval || 5000`，依赖数组同步改为 `state.slideshowConfig.interval`

#### Bug 2：`state.lanSession` 不存在
- 位置：[App.tsx L2429](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2429)
- 现状：依赖数组 `[useNativeViewer, state.lanSession]`
- 问题：`state` 上没有 `lanSession` 字段；LAN 连接状态由 [App.tsx L295](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L295) 的 `lanConnected` useState 管理
- 修复：依赖数组改为 `[useNativeViewer, lanConnected]`

## 实施方案

### 步骤 1：修复 App.tsx 中的 3 处变量名 Bug

**文件**：[src/App.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx)

1. L2402：`state.slideshowConfig.intervalMs || 5000` → `state.slideshowConfig.interval || 5000`
2. L2420 依赖数组：`state.slideshowConfig.intervalMs` → `state.slideshowConfig.interval`
3. L2429 依赖数组：`state.lanSession` → `lanConnected`

**原因**：当前代码无法通过 TypeScript 编译（`intervalMs` 和 `lanSession` 在类型上不存在），且即使编译通过，错误的依赖项会导致 useEffect 不在 LAN 连接状态变化时重新同步 token。

### 步骤 2：修改 ImageViewer.tsx 接收 `nativeViewerActive` prop

**文件**：[src/components/ImageViewer.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/ImageViewer.tsx)

#### 2.1 扩展 ViewerProps 接口（L419-459）
在 `enterImmersiveOnMount?: boolean;` 之后追加：
```typescript
  nativeViewerActive?: boolean; // 安卓原生查看器激活时，隐藏 WebView 内的图片渲染区
```

#### 2.2 组件参数解构（L467+）
在 `enterImmersiveOnMount = false,` 之后追加 `nativeViewerActive = false,`（带默认值，避免破坏其他调用方）。

需先确认 L467+ 的解构列表中 `enterImmersiveOnMount` 的位置和默认值形式。

#### 2.3 隐藏图片渲染区（L2472-2668）
原渲染区结构：
```tsx
<div className="w-full h-full flex items-center justify-center pointer-events-none relative overflow-hidden"
  style={isAndroidPlatformCached() ? { willChange: 'transform', contain: 'layout paint style' } : {}}>
  {/* 幻灯片过渡、主图、swipe 层等 */}
</div>
```

修改方案：在最外层 `<div>` 上根据 `nativeViewerActive` 控制显隐。最小侵入做法：
```tsx
<div
  className="w-full h-full flex items-center justify-center pointer-events-none relative overflow-hidden"
  style={{
    ...(isAndroidPlatformCached() ? { willChange: 'transform', contain: 'layout paint style' } : {}),
    ...(nativeViewerActive ? { display: 'none' } : {}),
  }}
>
```

**注意**：
- 只隐藏图片渲染区（L2472 这一层 div），保留顶栏、信息面板、设置面板等所有 UI 控件的渲染（它们在原生层激活时由 `activeTab.viewingFileId` 仍然存在而条件渲染，但用户实际看到的是覆盖在 WebView 上的 NativeGalleryView，WebView 内容被遮住）
- L2465-2470 的加载指示器也应一并隐藏（在 L2472 div 之外）—— 需检查后决定是否包裹进同一条件。简单做法：把 L2465-2470 加载指示器也加入 `nativeViewerActive` 判断（`{!displayUrl && !nativeViewerActive && (...)}`）
- 保留所有事件监听器（键盘、滑动）的挂载逻辑不变，但在 `nativeViewerActive` 为 true 时让它们 no-op（避免与原生层手势冲突）。如果事件监听器已在 hook 内根据 `isAndroidPlatformCached()` 短路，则无需额外改动 —— 需在实施时确认

### 步骤 3：App.tsx 传递 `nativeViewerActive` prop 给 ImageViewer

**文件**：[src/App.tsx L2698-2734](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2698-L2734)

在 `<ImageViewer ... />` 元素中追加一行：
```tsx
nativeViewerActive={nativeViewerActive}
```

建议放在 `enterImmersiveOnMount={state.settings.openInImmersiveByDefault}` 之后（L2733 之后）。

### 步骤 4：SettingsModal.tsx 新增"使用原生查看器"开关

**文件**：[src/components/SettingsModal.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/SettingsModal.tsx)

#### 4.1 参考现有 Android 专属设置模式
[SettingsModal.tsx L2543-2559](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/SettingsModal.tsx#L2543-L2559) 已有 `{isAndroid && (...)}` 块包裹的 `openInImmersiveByDefault` 开关，结构如下：
```tsx
{isAndroid && (
<div className="flex items-center justify-between pt-3 border-t border-gray-200 dark:border-gray-700" style={{ height: '55px' }}>
  <div>
    <div className="font-bold ...">{t('settings.openInImmersive')}</div>
    <div className="text-xs ... mt-1">{t('settings.openInImmersiveDesc')}</div>
  </div>
  <button
    onClick={() => {
      const newValue = !state.settings.openInImmersiveByDefault;
      onUpdateSettingsData({ openInImmersiveByDefault: newValue });
    }}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${state.settings.openInImmersiveByDefault ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
  >
    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${state.settings.openInImmersiveByDefault ? 'translate-x-6' : 'translate-x-1'}`} />
  </button>
</div>
)}
```

#### 4.2 在 `openInImmersiveByDefault` 块之后追加新开关
位置：L2559（`{isAndroid && (...)}` 块结束的 `)}` 之后），插入新的 `{isAndroid && (...)}` 块：
```tsx
{isAndroid && (
<div className="flex items-center justify-between pt-3 border-t border-gray-200 dark:border-gray-700" style={{ height: '55px' }}>
  <div>
    <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.useNativeViewer')}</div>
    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.useNativeViewerDesc')}</div>
  </div>
  <button
    onClick={() => {
      const newValue = !(state.settings.android?.useNativeViewer ?? true);
      onUpdateSettingsData({ android: { useNativeViewer: newValue } });
    }}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${(state.settings.android?.useNativeViewer ?? true) ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
  >
    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${(state.settings.android?.useNativeViewer ?? true) ? 'translate-x-6' : 'translate-x-1'}`} />
  </button>
</div>
)}
```

#### 4.3 i18n 文案
需检查 `t('settings.useNativeViewer')` 和 `t('settings.useNativeViewerDesc')` 的语言包定义。需先用 Grep 在 `src/locales/` 或 `src/i18n/` 中查找 `openInImmersive` 翻译键的位置，然后在同一文件追加：
- `useNativeViewer`: "使用原生查看器" / "Use Native Viewer"
- `useNativeViewerDesc`: "在安卓端使用原生图片查看器以获得更流畅的体验" / "Use native image viewer on Android for smoother experience"

如果项目使用 `t()` 但缺失 key 时会回退显示 key 字符串，则可先用现成 key 字符串占位，后续补 i18n。优先保证编译通过。

### 步骤 5：构建验证

#### 5.1 TypeScript / 前端构建
```bash
cd c:\Users\Misaki\Desktop\git\aurora-gallery-tauri
npx tsc --noEmit
npm run build
```
预期：无 TS 错误，Vite 构建成功。

#### 5.2 Rust 编译验证（非 Android target，验证 lib.rs 改动不破坏桌面端编译）
```bash
cd c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri
cargo check
```
预期：lib.rs 中 `#[cfg(target_os = "android")]` 包裹的 6 个新命令在桌面端不参与编译，应无错误。

#### 5.3 Android APK 构建（可选，如环境具备）
```bash
cd c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri
cargo tauri android build
```
如果环境没有 Android NDK / SDK，跳过此步，由用户在本地真机测试。

## 假设与决策

### 假设
1. 原生层（Kotlin）代码已通过编译，本计划仅修复前端集成问题
2. `onUpdateSettingsData` 函数支持嵌套对象更新（如 `android: { useNativeViewer: newValue }`），需在实施时验证；若不支持深合并，则需读取现有 `state.settings.android` 后展开：`android: { ...(state.settings.android || { useNativeViewer: true }), useNativeViewer: newValue }`
3. ImageViewer.tsx 的事件监听器在 `nativeViewerActive` 为 true 时不会与原生层手势冲突，因为 NativeGalleryView 覆盖在 WebView 之上，触摸事件先到达原生层
4. i18n 翻译键的添加位置遵循项目现有约定（需 Grep 确认）

### 决策
1. **不删除 WebView 内的图片渲染代码**：仅用 `display: none` 隐藏，保留作为回退方案。关闭 `useNativeViewer` 设置后立即恢复 WebView 模式
2. **不在 ImageViewer 内部判断 `isAndroidPlatformCached()`**：通过 `nativeViewerActive` prop 显式传入，职责分离，便于测试和回退
3. **SettingsModal 开关默认勾选**：`useNativeViewer` 默认 `true`，用户可主动关闭以回退到 WebView 模式
4. **最小化 ImageViewer 改动**：只隐藏图片渲染区，不动顶栏/侧栏/事件监听器。原生层覆盖在 WebView 上方，WebView 内的 UI 不可见即可

## 验证步骤

### 编译验证
1. `npx tsc --noEmit` 通过，无 `intervalMs` / `lanSession` 报错
2. `npm run build` 成功生成 dist/
3. `cargo check` 通过（桌面端不破坏）

### 功能验证（真机测试，由用户执行）
1. 打开图片 → 原生层立即覆盖显示
2. 左右滑动切换 → 150ms 内完成
3. 双击缩放 / pinch-zoom → 流畅
4. 顶栏"更多"按钮 → 触发 `onMore` 桥接，WebView 弹出菜单
5. 顶栏"删除"按钮 → 触发 `onDelete` 桥接，删除当前图片
6. 关闭原生查看器 → `nativeViewerActive` 变为 false，WebView ImageViewer 恢复显示
7. 设置中关闭"使用原生查看器" → 重新打开图片时使用 WebView 模式
8. LAN 图片 → token 通过 `android_native_viewer_set_lan_token` 同步后能正常加载

### 回退验证
1. 关闭 `useNativeViewer` 设置 → WebView ImageViewer 正常工作
2. `android_open_native_viewer` 调用失败 → catch 块设置 `nativeViewerActive=false`，回退到 WebView

## 实施顺序

1. 步骤 1：修复 App.tsx 3 处 Bug（最快，解除编译阻塞）
2. 步骤 2 + 3：ImageViewer.tsx 改动 + App.tsx 传 prop（成对修改，确保类型一致）
3. 步骤 4：SettingsModal 开关 + i18n 文案
4. 步骤 5：构建验证
