# App.tsx 拆分重构计划（精简版 - 仅前两项）

## 任务 1: Android 平台适配模块拆分

**源位置**: App.tsx 第 36-216 行
**目标文件**: `src/utils/androidPlatform.ts`
**内容**:

* `normalizePath` (第31行)

* `generateId` (第34行)

* `isAndroidPlatform` (第37-49行)

* `initAndroidPermissionListener` (第54-64行)

* `waitForAndroidPermission` (第66-79行)

* `ensureAndroidPermissionAndScan` (第81-129行)

* `scanAndroidMedia` (第131-214行)

* `initAndroidPermissionListener()` 调用 (第216行)

**步骤**:

1. 创建 `src/utils/androidPlatform.ts`，将上述函数迁移过去
2. 在 App.tsx 中 import 这些函数
3. 验证功能正常

## 任务 2: 应用初始化逻辑拆分

**源位置**: App.tsx 第 610-799 行（init useEffect 内部）
**目标文件**: `src/hooks/useAppInit.ts`
**内容**: Tauri 环境检测、用户数据加载、设置迁移、数据库加载（people/topics）、AI 连接检测、LAN 共享启动等初始化逻辑

**步骤**:

1. 创建 `src/hooks/useAppInit.ts`，将初始化逻辑封装为 hook
2. 在 App.tsx 中调用该 hook
3. 验证功能正常

