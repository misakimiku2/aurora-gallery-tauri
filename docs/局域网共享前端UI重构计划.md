# 局域网共享前端 UI 重构计划

## 背景

当前局域网共享前端使用的是简化版的 UI 组件，与主应用的 UI 风格不一致。目标是让局域网共享前端使用与主应用**完全相同**的 UI 组件代码，通过 API 适配器模式实现代码复用。

---

## 功能范围分析

### 局域网共享前端定位

局域网共享前端是一个**轻量级的图片浏览器**，主要用于：
- 在手机/平板等设备上浏览电脑上的图片
- 简单的图片查看和删除操作
- 通过 HTTP API 调用本机功能，可实现大部分主应用功能

### 核心设计理念

**「浏览器发起请求，本机执行操作」**

```
┌─────────────────┐         HTTP Request          ┌─────────────────┐
│  浏览器（手机）   │  ─────────────────────────>  │  本机后端服务    │
│                 │                                │                 │
│  发起操作请求    │  <─────────────────────────  │  执行实际操作    │
│  接收结果       │         HTTP Response         │  返回操作结果    │
└─────────────────┘                               └─────────────────┘
```

**优势**：
- 浏览器无需处理复杂逻辑
- 权限控制统一在后端
- 复用主应用的全部能力（数据库、AI 模型、文件系统）
- 操作结果实时同步

### 功能对比表

| 功能模块 | 主应用 | 局域网共享 | 后端支持 | 说明 |
|---------|--------|-----------|---------|------|
| **TopBar（顶部工具栏）** |||||
| 导航按钮（后退/前进/向上） | ✅ | ⚠️ 可选 | - | 纯前端状态管理 |
| 刷新按钮 | ✅ | ✅ 可实现 | - | 重新请求当前目录 |
| 侧边栏切换按钮 | ✅ | ⚠️ 可选 | - | 纯前端 |
| 搜索框 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search` |
| 搜索范围选择（全部/文件名/标签/文件夹） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?scope=xxx` |
| 颜色搜索（颜色选择器） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?color=xxx` |
| AI 语义搜索开关 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | 复用 CLIP 模型 |
| CLIP 图像搜索 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/clip-search` |
| 布局切换（网格/自适应/瀑布流） | ✅ | ✅ 已完成 | - | 纯前端 |
| 排序选项（名称/日期/大小/类型） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | 后端排序或前端排序 |
| 排序方向（升序/降序） | ✅ | ⚠️ 可选 | - | 纯前端或后端 |
| 缩略图大小调节 | ✅ | ⚠️ 可选 | - | 纯前端 |
| 分组选项（无/日期/类型/文件夹） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/group-files` |
| 日期筛选（日历组件） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?date=xxx` |
| 标签选择器（标签弹窗） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/tags` |
| 元数据面板切换按钮 | ✅ | ⚠️ 可选 | - | 纯前端 |
| 设置按钮 | ✅ | ❌ | - | 不需要 |
| 分页控件 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | 后端分页支持 |
| **TreeSidebar（左侧边栏）** |||||
| 文件夹树（展开/折叠） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/folder-tree` |
| 文件夹图标+名称 | ✅ | ⚠️ 可选 | - | 纯前端渲染 |
| 文件夹图片计数 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | 后端返回计数 |
| 当前路径高亮 | ✅ | ⚠️ 可选 | - | 纯前端状态 |
| 虚拟滚动（大量文件夹） | ✅ | ⚠️ 可选 | - | react-window |
| 人物列表（头像+名称+计数） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/persons` |
| 人物头像裁剪（人脸框） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | 后端返回 faceBox |
| 标签列表（分组显示） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/tags` |
| 标签搜索过滤 | ✅ | ⚠️ 可选 | - | 纯前端过滤 |
| 专题列表（封面+名称） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/topics` |
| 画布列表 | ✅ | ❌ | - | 不需要 |
| 收藏夹 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/favorites` |
| **MetadataPanel（右侧详情面板）** |||||
| 图片预览 | ✅ | ⚠️ 可选 | ✅ | `/api/thumbnail` |
| 文件名显示/编辑 | ✅ | ⚠️ 可选 | ✅ 已有 | `/api/rename` |
| 文件大小/尺寸/格式 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 创建/修改日期 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 主色调提取（调色板） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/colors` |
| 颜色搜索（点击颜色） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?color=xxx` |
| 标签显示/添加/删除 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/tags` |
| 描述编辑 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 来源网址编辑 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 文件夹分类（普通/书籍/序列） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 文件夹统计（类型分布图表） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | 后端计算 |
| 人物信息面板 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/persons/:id` |
| 专题信息面板 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/topics/:id` |
| AI 重命名建议 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/ai-rename` |
| 多选批量编辑 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | 批量 API |
| **FileGrid** |||||
| 虚拟滚动 | ✅ | ✅ 已完成 | - | 纯前端计算 |
| 缩略图懒加载 | ✅ | ✅ 已完成 | ✅ | `/api/thumbnail` |
| 缓存机制 | ✅ | ✅ 已完成 | - | 纯前端优化 |
| 布局计算（Grid/Adaptive/Masonry） | ✅ | ✅ 已完成 | - | 纯前端计算 |
| 布局切换控件 | ✅ | ✅ 已完成 | - | 下拉菜单样式 |
| 左侧边栏（文件夹树） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/folder-tree` |
| 右侧边栏（元数据面板） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 列表布局 | ✅ | ❌ | - | 不需要 |
| 分组功能 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/group-files` |
| 内部拖拽（移动文件） | ✅ | ❌ | - | 浏览器无法实现 |
| 外部拖拽（拖到系统） | ✅ | ❌ | - | 浏览器无法实现 |
| 移动/复制到文件夹 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/move`, `/api/copy` |
| 重命名 | ✅ | ⚠️ 可选 | ✅ 已有 | `/api/rename` |
| 多选框选 | ✅ | ⚠️ 可选 | - | 配合批量操作 |
| 滚轮缩放缩略图 | ✅ | ❌ | - | 不需要 |
| 右键菜单 | ✅ | ⚠️ 简化版 | - | 根据权限显示 |
| **搜索与筛选** |||||
| 文件名搜索 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search` |
| 标签搜索 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?scope=tag` |
| 颜色搜索 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?color=xxx` |
| AI 语义搜索 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?ai=xxx` |
| 日期筛选 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/search?date=xxx` |
| **人物视图** |||||
| 人物列表 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/persons` |
| 人物图片 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/persons/:id/images` |
| **标签视图** |||||
| 标签列表 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/tags` |
| 标签图片 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/tags/:name/images` |
| **ImageViewer** |||||
| 图片变换（缩放/旋转/拖拽） | ✅ | ✅ 已完成 | - | 纯前端 |
| 键盘导航 | ✅ | ✅ 已完成 | - | 纯前端 |
| 全屏模式 | ✅ | ✅ 已完成 | - | 纯前端 |
| 幻灯片模式 | ✅ | ✅ 已完成 | - | 纯前端 |
| 幻灯片过渡动画 | ✅ | ✅ 已完成 | - | fade/slide |
| Ken Burns 效果 | ✅ | ✅ 已完成 | - | 纯前端 |
| 双击切换原始/适应 | ✅ | ✅ 已完成 | - | 纯前端 |
| 滚轮缩放 | ✅ | ✅ 已完成 | - | 以鼠标为中心 |
| 中键切换原始/适应 | ✅ | ✅ 已完成 | - | 纯前端 |
| 页码指示器 | ✅ | ✅ 已完成 | - | 切换时淡入淡出 |
| 缩放滑块 | ✅ | ❌ 已移除 | - | 性能问题，使用滚轮代替 |
| 1:1 按钮 | ✅ | ❌ 已移除 | - | 使用双击/中键代替 |
| 适应屏幕按钮 | ✅ | ❌ 已移除 | - | 使用双击/中键代替 |
| 右侧详情面板 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 主色调识别 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/colors` |
| 详细信息（EXIF） | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 标签显示/编辑 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/tags` |
| 描述编辑 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 来源网址 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/metadata` |
| 复制图片到剪贴板 | ✅ | ⚠️ 可选 | - | 浏览器支持有限 |
| 在资源管理器中查看 | ✅ | ❌ | - | 浏览器无法实现 |
| JXL/AVIF 预览 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/preview/jxl` |
| AI 分析 | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/ai-analyze` |
| 图片对比 | ✅ | ❌ | - | 不需要 |
| **ImageThumbnail** |||||
| 缩略图加载 | ✅ | ✅ 已完成 | ✅ | `/api/thumbnail` |
| 缓存机制 | ✅ | ✅ 已完成 | - | 纯前端 |
| 懒加载 | ✅ | ✅ 已完成 | - | 纯前端 |
| 过渡动画 | ✅ | ✅ 已完成 | - | 纯前端 |
| Hover 播放 GIF/WebP | ✅ | ⚠️ 可选 | ⚠️ 需新增 | `/api/file-base64` |
| **FolderThumbnail** |||||
| 3D 效果 | ✅ | ✅ 已完成 | - | 纯前端 |
| 预览图 | ✅ | ✅ 已完成 | ✅ | `/api/thumbnail` |
| 文件计数 | ✅ | ✅ 已完成 | ✅ | 后端返回 size 字段 |

### 图例说明
- ✅ **已完成**：已实现的功能
- ⚠️ **可选/待实现**：根据后端支持情况决定，通过 props 控制功能开关
- ❌ **不需要**：技术限制或无意义的功能

### 功能优先级

| 优先级 | 功能 | 后端工作量 | 状态 |
|-------|------|----------|------|
| P0 | 缩略图、图片查看、删除 | ✅ 已完成 | ✅ 已完成 |
| P0 | FileGrid 核心功能（虚拟滚动、布局切换） | - | ✅ 已完成 |
| P0 | FolderThumbnail（3D效果、预览图、计数） | ✅ 已完成 | ✅ 已完成 |
| P1 | ImageViewer 核心功能 | - | ✅ 已完成 |
| P1 | 重命名、移动/复制文件 | 低 | ⚠️ 待实现 |
| P1 | 搜索（文件名、标签） | 中 | ⚠️ 待实现 |
| P2 | 颜色搜索、日期筛选 | 中 | ⚠️ 待实现 |
| P2 | 人物视图、标签视图 | 中 | ⚠️ 待实现 |
| P2 | 右侧详情面板（元数据、颜色） | 低 | ⚠️ 待实现 |
| P3 | AI 语义搜索 | 低（已有模型） | ⚠️ 待实现 |
| P3 | 标签编辑、描述编辑 | 低 | ⚠️ 待实现 |

---

## 核心问题

| 组件 | 主应用 | 当前共享组件 | 状态 |
|------|--------|-------------|------|
| FileGrid | 1475 行，复杂拖拽、缓存、虚拟滚动 | ✅ 已创建核心功能版 | ✅ 已完成 |
| ImageViewer | 1679 行，幻灯片、颜色提取、搜索 | ✅ 已创建核心功能版 | ✅ 已完成 |
| ImageThumbnail | 155 行，缓存、懒加载、动画 | ✅ 已创建完整版 | ✅ 已完成 |
| FolderThumbnail | 138 行，3D 效果、预览图 | ✅ 已创建完整版 | ✅ 已完成 |
| Folder3DIcon | 3D 文件夹图标组件 | ✅ 已创建完整版 | ✅ 已完成 |
| TopBar | 1191 行，搜索、排序、筛选、布局切换 | ⚠️ 待创建 | ⚠️ 待实现 |
| TreeSidebar | 1634 行，文件夹树、人物、标签、专题 | ⚠️ 待创建 | ⚠️ 待实现 |
| MetadataPanel | ~2500 行，元数据、颜色、标签、描述 | ⚠️ 待创建 | ⚠️ 待实现 |

---

## 重构策略

### 方案：API 适配器模式

```
┌─────────────────────────────────────────────────────────────┐
│                    共享组件库 (shared)                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              完整的 UI 组件                           │    │
│  │  • FileGrid (核心功能版，抽象 API 层)  ✅            │    │
│  │  • ImageViewer (核心功能版，抽象 API 层)  ⚠️ 待实现  │    │
│  │  • ImageThumbnail (完整版)  ✅                       │    │
│  │  • FolderThumbnail (完整版)  ✅                      │    │
│  │  • Folder3DIcon (完整版)  ✅                         │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              API 适配器接口                          │    │
│  │  • ImageApi (图片 URL、缩略图)  ✅                   │    │
│  │  • FileApi (删除)  ✅                                │    │
│  │  • BrowseApi (浏览目录)  ✅                          │    │
│  │  • ExtendedApi (可选扩展功能)  ⚠️                    │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           │                               │
           ▼                               ▼
┌─────────────────────┐         ┌─────────────────────┐
│      主应用          │         │   局域网共享前端     │
│                     │         │                     │
│  TauriAdapter       │         │  HttpAdapter  ✅     │
│  • invoke() 调用    │         │  • fetch() 调用     │
│  • convertFileSrc   │         │  • HTTP API         │
│  • 完整功能         │         │  • 简化功能         │
└─────────────────────┘         └─────────────────────┘
```

---

## 实施任务清单

### 阶段一：完善 API 适配器接口 ✅ 已完成

#### 任务 1.1：定义核心 API 接口 ✅
- [x] 文件：`src/shared/api/types.ts`
- [x] 定义核心 API 接口：
  - `ImageApi` - 图片 URL、缩略图
  - `FileApi` - 文件操作
  - `BrowseApi` - 浏览目录
  - `BrowseItem` - 文件/文件夹项（包含 type, width, height, preview_images, size）
  - `LayoutMode` - 布局模式（grid/masonry/adaptive）

#### 任务 1.2：完善 HttpAdapter 实现 ✅
- [x] 文件：`src/shared/api/adapters/HttpAdapter.ts`
- [x] 实现核心 API 接口的 HTTP 版本
- [x] 参考：`src/lan-share/api.ts`

#### 任务 1.3：完善 TauriAdapter 实现
- [ ] 文件：`src/shared/api/adapters/TauriAdapter.ts`
- [ ] 实现所有 API 接口的 Tauri 版本
- [ ] 参考：`src/api/tauri-bridge.ts`

---

### 阶段二：提取缩略图组件 ✅ 已完成

#### 任务 2.1：创建共享 ImageThumbnail ✅
- [x] 文件：`src/shared/components/Thumbnails/ImageThumbnail.tsx`
- [x] 提取核心逻辑：
  - 缩略图加载
  - 缓存机制
  - 懒加载逻辑
  - 过渡动画

#### 任务 2.2：创建共享 FolderThumbnail ✅
- [x] 文件：`src/shared/components/Thumbnails/FolderThumbnail.tsx`
- [x] 提取 3D 效果和预览图逻辑

#### 任务 2.3：创建共享 Folder3DIcon ✅
- [x] 文件：`src/shared/components/Thumbnails/Folder3DIcon.tsx`
- [x] 3D 文件夹图标组件
- [x] 预览图片层叠效果
- [x] 文件计数显示

#### 任务 2.4：创建 Thumbnails 索引文件 ✅
- [x] 文件：`src/shared/components/Thumbnails/index.ts`

---

### 阶段三：提取 FileGrid 组件 ✅ 已完成

#### 任务 3.1：创建布局计算 Hook ✅
- [x] 文件：`src/shared/hooks/useLayout.ts`
- [x] 支持 Grid 布局
- [x] 支持 Masonry（瀑布流）布局
- [x] 支持 Adaptive（自适应）布局
- [x] 支持外部传入 aspectRatios

#### 任务 3.2：创建虚拟滚动 Hook ✅
- [x] 文件：`src/shared/hooks/useVirtualScroll.ts`
- [x] 虚拟滚动计算逻辑

#### 任务 3.3：创建布局切换控件 ✅
- [x] 文件：`src/shared/components/Grid/LayoutSwitcher.tsx`
- [x] 下拉菜单样式
- [x] 三种布局模式切换

#### 任务 3.4：创建共享 FileGrid 和 FileCard ✅
- [x] 文件：`src/shared/components/Grid/FileGrid.tsx`
- [x] 文件：`src/shared/components/Grid/FileCard.tsx`
- [x] 提取核心功能：
  - ✅ 虚拟滚动
  - ✅ 缩略图懒加载
  - ✅ 布局计算（Grid/Adaptive/Masonry）
  - ✅ 点击/双击事件
  - ✅ 文件夹预览图
  - ✅ 文件夹计数

#### 任务 3.5：创建 Grid 索引文件 ✅
- [x] 文件：`src/shared/components/Grid/index.ts`

---

### 阶段四：提取 ImageViewer 组件 ✅ 已完成

#### 任务 4.1：完善 useImageTransform hook ✅
- [x] 文件：`src/shared/hooks/useImageTransform.ts`
- [x] 已完成功能：
  - ✅ 旋转动画（rotate 方法）
  - ✅ 双击缩放逻辑（支持原始尺寸切换）
  - ✅ 中键切换逻辑（handleMiddleClick）
  - ✅ fitToWindow / setToOriginalSize 方法
  - ✅ easeOutBack / easeOutQuint 缓动曲线

#### 任务 4.2：创建幻灯片管理 ✅
- [x] 文件：`src/shared/hooks/useSlideshow.ts`
- [x] 已完成功能：
  - ✅ 自动播放（可配置间隔时间）
  - ✅ 过渡动画（fade/slide/none）
  - ✅ Ken Burns 效果开关
  - ✅ 随机模式
  - ✅ 全屏模式管理

#### 任务 4.3：创建共享 ImageViewer ✅
- [x] 文件：`src/shared/components/ImageViewer/ImageViewerCore.tsx`
- [x] 文件：`src/shared/components/ImageViewer/ImageViewerControls.tsx`
- [x] 文件：`src/shared/components/ImageViewer/SlideshowManager.tsx`
- [x] 文件：`src/shared/components/ImageViewer/index.ts`
- [x] 已完成功能：
  - ✅ 图片变换（缩放/旋转/拖拽）
  - ✅ 键盘导航（方向键/ESC）
  - ✅ 全屏模式
  - ✅ 幻灯片模式
  - ✅ 幻灯片过渡动画（fade/slide）
  - ✅ Ken Burns 效果
  - ✅ 页码指示器（切换时淡入淡出）
  - ✅ 顶部工具栏（旋转、全屏、幻灯片按钮）
  - ✅ 幻灯片设置面板
  - ❌ 已移除：缩放滑块、1:1按钮、适应屏幕按钮（性能问题）

#### 任务 4.4：添加 CSS 动画 ✅
- [x] 文件：`index.css` - 主应用动画
- [x] 文件：`src/lan-share/lan-share.css` - 局域网共享动画
- [x] 已添加动画：
  - ✅ animate-ken-burns（Ken Burns 效果）
  - ✅ animate-slideshow-fade-in/out（淡入淡出）
  - ✅ animate-slideshow-slide-in/out（滑动）

#### 任务 4.5：更新局域网共享 ImageViewer ✅
- [x] 文件：`src/lan-share/components/ImageViewer.tsx`
- [x] 使用共享 ImageViewerCore 组件
- [x] 启用幻灯片功能
- [x] 启用全屏功能

---

### 阶段五：提取 TopBar 组件 ✅ 已完成

#### 任务 5.1：创建共享 TopBar
- [x] 文件：`src/shared/components/TopBar/TopBar.tsx`
- [x] 提取核心功能：
  - 导航按钮（后退/前进/向上）
  - 刷新按钮
  - 搜索框（支持搜索范围选择：全部/文件名/文件夹）
  - 布局切换控件
  - 排序选项（名称/日期/大小）
  - 排序方向（升序/降序）

#### 任务 5.2：创建子组件
- [x] 文件：`src/shared/components/TopBar/NavigationButtons.tsx`
- [x] 文件：`src/shared/components/TopBar/SortControls.tsx`
- [x] 文件：`src/shared/components/TopBar/SearchInput.tsx`
- [x] 文件：`src/shared/components/TopBar/index.ts`

#### 任务 5.3：更新局域网共享前端
- [x] 文件：`src/lan-share/LanShareApp.tsx` - 添加状态管理和导航历史
- [x] 文件：`src/lan-share/components/BrowseScreen.tsx` - 使用共享 TopBar
- [x] 文件：`src/shared/components/Grid/FileGrid.tsx` - 支持外部布局模式控制

---

### 阶段六：提取 TreeSidebar 组件 ⚠️ 待实现

#### 任务 6.1：创建共享 TreeSidebar
- [ ] 文件：`src/shared/components/Sidebar/TreeSidebar.tsx`
- [ ] 提取核心功能：
  - 文件夹树（展开/折叠）
  - 虚拟滚动
  - 当前路径高亮
  - 点击导航

#### 任务 6.2：创建子组件
- [ ] 文件：`src/shared/components/Sidebar/FolderSection.tsx`
- [ ] 文件：`src/shared/components/Sidebar/PeopleSection.tsx`
- [ ] 文件：`src/shared/components/Sidebar/TagSection.tsx`
- [ ] 文件：`src/shared/components/Sidebar/TopicSection.tsx`
- [ ] 文件：`src/shared/components/Sidebar/index.ts`

---

### 阶段七：提取 MetadataPanel 组件 ⚠️ 待实现

#### 任务 7.1：创建共享 MetadataPanel
- [ ] 文件：`src/shared/components/Metadata/MetadataPanel.tsx`
- [ ] 提取核心功能：
  - 图片预览
  - 文件信息显示
  - 主色调提取
  - 标签管理
  - 描述/来源编辑

#### 任务 7.2：创建子组件
- [ ] 文件：`src/shared/components/Metadata/ImagePreview.tsx`
- [ ] 文件：`src/shared/components/Metadata/ColorPalette.tsx`
- [ ] 文件：`src/shared/components/Metadata/TagEditor.tsx`
- [ ] 文件：`src/shared/components/Metadata/FolderStats.tsx`
- [ ] 文件：`src/shared/components/Metadata/PersonAvatar.tsx`
- [ ] 文件：`src/shared/components/Metadata/index.ts`

---

### 阶段八：重构局域网共享前端 ✅ 已完成

#### 任务 8.1：重构 BrowseScreen ✅
- [x] 文件：`src/lan-share/components/BrowseScreen.tsx`
- [x] 使用共享 FileGrid 组件
- [x] 使用共享 ImageThumbnail/FolderThumbnail

#### 任务 8.2：重构 ImageViewer ✅
- [x] 文件：`src/lan-share/components/ImageViewer.tsx`
- [x] 使用共享 ImageViewerCore 组件
- [x] 启用幻灯片功能
- [x] 启用全屏功能
- [x] 启用所有图片变换功能

#### 任务 8.3：重构 AuthScreen
- [ ] 文件：`src/lan-share/components/AuthScreen.tsx`
- [ ] 确保样式与主应用一致

---

### 阶段九：重构主应用组件

#### 任务 9.1：重构主应用 FileGrid
- [ ] 文件：`src/components/FileGrid.tsx`
- [ ] 使用共享 FileGrid 组件
- [ ] 使用 TauriAdapter
- [ ] 保留主应用特有功能（拖拽、多选、分组等）

#### 任务 9.2：重构主应用 ImageViewer
- [ ] 文件：`src/components/ImageViewer.tsx`
- [ ] 使用共享 ImageViewerCore 组件
- [ ] 使用 TauriAdapter
- [ ] 保留主应用特有功能（搜索、颜色提取、标签编辑等）

---

### 阶段十：测试与验证

#### 任务 10.1：主应用测试
- [ ] 启动主应用，验证所有功能正常
- [ ] 测试文件浏览、图片查看、拖拽等功能

#### 任务 10.2：局域网共享测试
- [x] 启动局域网共享，验证 UI 与主应用一致
- [x] 测试文件浏览功能
- [x] 测试布局切换功能
- [ ] 在手机/平板上测试

---

## 文件结构规划

```
src/shared/
├── api/
│   ├── types.ts                    # API 接口定义 ✅
│   ├── adapters/
│   │   ├── TauriAdapter.ts         # Tauri API 实现 ⚠️ 待实现
│   │   ├── HttpAdapter.ts          # HTTP API 实现 ✅
│   │   └── index.ts
│   └── index.ts
├── components/
│   ├── Grid/
│   │   ├── FileGrid.tsx            # 文件网格 ✅
│   │   ├── FileCard.tsx            # 文件卡片 ✅
│   │   ├── LayoutSwitcher.tsx      # 布局切换 ✅
│   │   └── index.ts                # 索引文件 ✅
│   ├── Thumbnails/
│   │   ├── ImageThumbnail.tsx      # 图片缩略图 ✅
│   │   ├── FolderThumbnail.tsx     # 文件夹缩略图 ✅
│   │   ├── Folder3DIcon.tsx        # 3D 文件夹图标 ✅
│   │   └── index.ts                # 索引文件 ✅
│   ├── ImageViewer/
│   │   ├── ImageViewerCore.tsx     # 图片查看器核心 ✅
│   │   ├── ImageViewerControls.tsx # 控制按钮 ✅
│   │   ├── SlideshowManager.tsx    # 幻灯片管理 ✅
│   │   └── index.ts                # 索引文件 ✅
│   ├── TopBar/
│   │   ├── TopBar.tsx              # 顶部工具栏 ⚠️ 待实现
│   │   ├── PaginationControls.tsx  # 分页控件 ⚠️ 待实现
│   │   ├── TagsWidget.tsx          # 标签选择器 ⚠️ 待实现
│   │   ├── CalendarWidget.tsx      # 日期筛选器 ⚠️ 待实现
│   │   └── index.ts
│   ├── Sidebar/
│   │   ├── TreeSidebar.tsx         # 左侧边栏 ⚠️ 待实现
│   │   ├── FolderSection.tsx       # 文件夹树 ⚠️ 待实现
│   │   ├── PeopleSection.tsx       # 人物列表 ⚠️ 待实现
│   │   ├── TagSection.tsx          # 标签列表 ⚠️ 待实现
│   │   ├── TopicSection.tsx        # 专题列表 ⚠️ 待实现
│   │   └── index.ts
│   ├── Metadata/
│   │   ├── MetadataPanel.tsx       # 右侧详情面板 ⚠️ 待实现
│   │   ├── ImagePreview.tsx        # 图片预览 ⚠️ 待实现
│   │   ├── ColorPalette.tsx        # 颜色调色板 ⚠️ 待实现
│   │   ├── TagEditor.tsx           # 标签编辑器 ⚠️ 待实现
│   │   ├── FolderStats.tsx         # 文件夹统计 ⚠️ 待实现
│   │   ├── PersonAvatar.tsx        # 人物头像 ⚠️ 待实现
│   │   └── index.ts
│   ├── UI/
│   │   ├── BreadcrumbNav.tsx       # 面包屑导航
│   │   ├── LoadingSpinner.tsx      # 加载指示器
│   │   ├── EmptyPlaceholder.tsx    # 空状态
│   │   └── index.ts
│   └── index.ts
├── hooks/
│   ├── useInView.ts                # 视口检测 ✅
│   ├── useImageTransform.ts        # 图片变换 ✅
│   ├── useLayout.ts                # 布局计算 ✅
│   ├── useVirtualScroll.ts         # 虚拟滚动 ✅
│   ├── useSlideshow.ts             # 幻灯片 ✅
│   └── index.ts
├── utils/
│   ├── debounce.ts                 # 防抖/节流
│   ├── cache.ts                    # LRU 缓存
│   └── index.ts
├── types/
│   ├── file.ts                     # 文件类型
│   ├── image.ts                    # 图片类型
│   └── index.ts
└── index.ts
```

---

## 后端 API 扩展需求

### 已有 API

| API | 方法 | 说明 |
|-----|------|------|
| `/api/auth/verify` | POST | 设备认证 |
| `/api/browse` | GET | 浏览目录（已扩展：返回 width/height/preview_images/size） |
| `/api/thumbnail` | GET | 获取缩略图 |
| `/api/image` | GET | 获取原图 |
| `/api/file` | DELETE | 删除文件 |
| `/api/rename` | POST | 重命名文件 |
| `/api/devices` | GET | 获取在线设备 |

### 后端已完成的扩展

| 扩展 | 说明 |
|-----|------|
| `preview_images` 字段 | 文件夹预览图片路径列表（最多3张） |
| `width`/`height` 字段 | 图片尺寸信息 |
| `size` 字段（文件夹） | 文件夹内文件/子文件夹数量 |
| 图片尺寸获取修复 | 修复了使用错误路径获取图片尺寸的 bug |

### 待新增 API

| 优先级 | API | 方法 | 说明 | 后端实现 |
|-------|-----|------|------|---------|
| P1 | `/api/move` | POST | 移动文件 | `fs::rename` |
| P1 | `/api/copy` | POST | 复制文件 | `fs::copy` |
| P1 | `/api/search` | GET | 搜索文件 | 复用 `db_commands.rs` |
| P2 | `/api/folder-tree` | GET | 文件夹树 | 递归遍历 |
| P2 | `/api/metadata` | GET | 图片元数据 | 复用 `file_metadata.rs` |
| P2 | `/api/colors` | GET | 主色调 | 复用 `color_commands.rs` |
| P2 | `/api/persons` | GET | 人物列表 | 复用 `db/persons.rs` |
| P2 | `/api/tags` | GET | 标签列表 | 复用数据库 |
| P3 | `/api/ai-analyze` | POST | AI 分析 | 复用 `clip_commands.rs` |
| P3 | `/api/file-base64` | GET | 文件 Base64 | 用于 GIF 播放 |
| P3 | `/api/preview/jxl` | GET | JXL 预览 | 复用转码逻辑 |
| P3 | `/api/preview/avif` | GET | AVIF 预览 | 复用转码逻辑 |

---

## 注意事项

1. **保持功能完整**：提取组件时不能丢失主应用的任何功能
2. **API 抽象**：所有 Tauri/HTTP 调用必须通过适配器
3. **样式一致**：使用相同的 Tailwind 类名
4. **性能优化**：保留所有性能优化（虚拟滚动、懒加载、缓存）
5. **功能裁剪**：局域网共享仅保留核心功能，通过 props 控制功能开关
6. **测试验证**：每个阶段完成后都要测试

---

## 参考文件

### 主应用组件
- `src/components/FileGrid.tsx` - 文件网格
- `src/components/ImageViewer.tsx` - 图片查看器
- `src/components/ImageThumbnail.tsx` - 图片缩略图
- `src/components/FolderThumbnail.tsx` - 文件夹缩略图
- `src/components/Folder3DIcon.tsx` - 3D 文件夹图标
- `src/components/TopBar.tsx` - 顶部工具栏（1191 行）
- `src/components/TreeSidebar.tsx` - 左侧边栏（1634 行）
- `src/components/MetadataPanel.tsx` - 右侧详情面板（约 2500 行）

### API 桥接
- `src/api/tauri-bridge.ts` - Tauri API 封装
- `src/lan-share/api.ts` - HTTP API 封装

### 工具函数
- `src/utils/thumbnailCache.ts` - 缩略图缓存
- `src/utils/debounce.ts` - 防抖/节流
- `src/hooks/useInView.ts` - 视口检测

---

**文档版本**: 4.0  
**创建日期**: 2026-03-12  
**更新日期**: 2026-03-12  
**预计工作量**: 20-30 小时（包含 TopBar、TreeSidebar、MetadataPanel）
