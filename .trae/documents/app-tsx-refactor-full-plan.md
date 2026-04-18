# App.tsx 瘦身重构计划

> 原始行数：5211 行 | 当前行数：4969 行（P2-10/11/12/14 已提取，P1 hook 文件已创建但代码尚在 App.tsx 中） | 本次 P2 提取：242 行

## 已完成

### ✅ 1. Android 平台适配模块（约 180 行）

- **目标文件**: `src/utils/androidPlatform.ts`
- **内容**: `isAndroidPlatform`, `initAndroidPermissionListener`, `waitForAndroidPermission`, `ensureAndroidPermissionAndScan`, `scanAndroidMedia`
- **辅助文件**: `src/utils/pathUtils.ts`（提取 `normalizePath`, `generateId` 为共享工具）
- **理由**: 这些函数完全独立于 React 组件，是纯工具函数，仅在初始化时调用。移动版本开发时需要重点修改此模块。

### ✅ 2. 应用初始化逻辑（约 200 行）

- **目标文件**: `src/hooks/useAppInit.ts`
- **内容**: Tauri 环境检测、用户数据加载、设置迁移、数据库加载（people/topics）、AI 连接检测、LAN 共享启动
- **理由**: 初始化逻辑非常复杂且独立，是移动版本适配的关键点。拆分后可针对不同平台定制初始化流程。

### ✅ 3. 目录扫描与刷新模块（约 290 行）

- **目标文件**: `src/hooks/useDirectoryScan.ts`
- **内容**: `handleOpenFolder`, `scanAndMerge`, `handleRefresh`, `handleRefreshTags`, `handleChangePath`
- **理由**: 目录扫描逻辑复杂，包含骨架屏创建、数据库切换、进度追踪等。移动版本的文件系统访问方式完全不同。

### ✅ 4. 窗口与生命周期管理模块（约 100 行）

- **目标文件**: `src/hooks/useWindowLifecycle.ts`
- **内容**: 窗口关闭监听（exitActionRef 同步、onCloseRequested）、窗口标题更新、退出确认逻辑（`handleExitConfirm`, `handleCloseConfirmation`）
- **理由**: 窗口管理是桌面端特有逻辑，移动版本完全不需要。

### ✅ 5. 搜索功能模块（约 450 行）

- **目标文件**: `src/hooks/useSearch.ts`
- **内容**: `performAiSearch`, `onPerformSearch`, `handlePerformSearch`, `handleViewerSearch`, `handleSearchSimilarImages`, `handleClipEnabledChange`, `openClipSettings`, 颜色搜索 useEffect, `isClipSearchEnabled`/`clipLoading` 状态
- **理由**: 搜索逻辑包含 AI 搜索、CLIP 语义搜索、调色板搜索、颜色搜索、以图搜图等多种模式，代码量大且逻辑独立。CLIP/视觉搜索状态管理（原 Item 13）也一并合并到此模块。

### ✅ 6. 人物管理模块（约 580 行）

- **目标文件**: `src/hooks/usePeople.ts`
- **内容**: `handlePersonClick`, `handleRenamePerson`, `handleUpdatePerson`, `handleCreatePerson`, `handleConfirmCreatePerson`, `handleSmartCreatePerson`, `handleSmartAddToPerson`, `handleDeletePerson`, `handleManualAddPerson`, `handleSetAvatar`, `handleSaveAvatarCrop`, `handleSaveAvatarCropForSmartCreate`, `handleClearPersonInfo`, `onStartRenamePerson`, `handleOpenCropAvatar`
- **理由**: 人物相关操作非常集中，包含 CRUD、智能创建、头像裁剪等。移动版本的人物交互方式会有差异。

### ✅ 7. 专题管理模块（约 180 行）

- **目标文件**: `src/hooks/useTopics.ts`
- **内容**: `handleSmartCreateTopic`, `handleManualAddToTopic`, `handleCreateTopic`, `handleUpdateTopic`, `handleDeleteTopic`, `handleCreateRootTopic`
- **理由**: 专题 CRUD 操作逻辑独立，移动版本可能需要不同的专题交互方式。

### ✅ 8. 标签管理模块（约 165 行）

- **目标文件**: `src/hooks/useTags.ts`
- **内容**: `requestDeleteTags`, `handleConfirmDeleteTags`, `handleCopyTags`, `handlePasteTags`, `handleCreateNewTag`, `handleSaveNewTag`, `handleCancelCreateTag`, `handleOverviewTagClick`, `handleTagClick`, `handleRenameTag`, `handleClearTagFilter`, `handleClearAllTags`, `isCreatingTag` 状态
- **理由**: 标签操作逻辑独立且完整，包含复制/粘贴/创建/删除/重命名等。

***

## 待拆分模块

### 🟡 P2 - 进一步优化

#### 9. 视图导航模块（约 100 行）

- **位置**: App.tsx 第 4238-4310 行
- **内容**: `enterTagView`, `enterTagsOverview`, `enterPeopleOverview`, `enterPersonView`, `handleNavigateUp`, `handleNavigateFolder`, `handleNavigateTopic`, `handleNavigatePerson`, `handleNavigateTopics`
- **目标文件**: 合并到已有的 `src/hooks/useNavigation.ts`
- **理由**: 这些导航函数与现有 useNavigation 职责高度相关，应统一管理。

#### 10. 外部拖拽处理模块（约 100 行） ✅

- **位置**: App.tsx 第 1962-2053 行
- **内容**: `handleExternalDragEnter`, `handleExternalDragOver`, `handleExternalDragLeave`, `handleExternalDrop` 及相关状态
- **目标文件**: `src/hooks/useExternalDragDrop.ts` ✅
- **理由**: 外部拖拽逻辑独立，移动版本不需要此功能。

#### 11. 持久化与自动保存模块（约 60 行） ✅

- **位置**: App.tsx 第 559-608 行
- **内容**: 自动保存 useEffect（saveUserData 函数保留在 App.tsx 中供多处调用）
- **目标文件**: `src/hooks/usePersistence.ts` ✅
- **理由**: 数据持久化逻辑独立，移动版本可能使用不同的存储方式。

#### 12. 文件选择与交互模块（约 60 行） ✅

- **位置**: App.tsx 第 1710-1766 行
- **内容**: `handleFileClick`（多选/Ctrl/Shift 逻辑）
- **目标文件**: `src/hooks/useFileSelection.ts` ✅
- **理由**: 文件选择交互逻辑在移动端需要完全不同的实现（长按代替 Ctrl+Click）。

#### 14. 文件夹设置记忆模块（约 80 行） ✅

- **位置**: App.tsx 第 3417-3518 行
- **内容**: `handleRememberFolderSettings`, folderSettings 相关 useEffect（savedDataLoadedRef/savedDataLoaded 保留在 App.tsx）
- **目标文件**: `src/hooks/useFolderSettings.ts` ✅
- **理由**: 文件夹设置记忆逻辑独立，移动版本可能不需要此功能。

#### 15. 渲染层 - 过滤器 UI 组件（约 100 行）

- **位置**: App.tsx 第 4742-4864 行（JSX 中的过滤器标签/分页区域）
- **内容**: 搜索过滤器标签、AI 过滤器标签、日期过滤器、人物过滤器、标签过滤器、分页控件
- **目标文件**: `src/components/FilterBar.tsx`
- **理由**: 这段 JSX 代码纯展示逻辑，可以独立为组件，减少 App.tsx 的渲染代码量。

***

## 预估效果

| 阶段            | App.tsx 行数 | 减少行数   |
| ------------- | ---------- | ------ |
| 原始            | 5211       | -      |
| 已完成（1+2）      | 4657       | 554    |
| P0 完成（+3+4）   | 4060       | 1151   |
| P1 部分完成（+5+6） | 2917       | 2294   |
| P1 部分完成（+7）   | 2738       | 2473   |
| **P1 全部完成（+8）** | **2574**   | **2637** |
| P2 全部完成       | \~2400     | \~2811 |

***

## 实施注意事项

1. **渐进式拆分**: 每次只拆分一个模块，确保每次拆分后应用功能正常
2. **保持接口稳定**: 拆分出的 hook 需要保持与 App 组件的接口清晰
3. **状态共享**: 多个 hook 之间通过 `state` 和 `setState` 共享状态，需要注意依赖关系
4. **避免循环依赖**: 拆分时注意 hook 之间的调用关系，避免循环依赖
5. **测试验证**: 每次拆分后需要验证功能完整性

