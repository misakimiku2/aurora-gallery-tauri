# 局域网共享前端 UI 统一方案实施计划

## 目标

将局域网共享前端与主应用的 UI 完全统一，通过创建共享组件库实现代码复用，确保两边的界面永远保持一致。

---

## 核心思路

```
┌─────────────────────────────────────────────────────────────┐
│                      共享组件库 (shared)                      │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ UI 组件     │ │ Hooks       │ │ 工具函数    │            │
│  │ (纯界面)    │ │ (通用逻辑)  │ │ (基础工具)  │            │
│  └─────────────┘ └─────────────┘ └─────────────┘            │
│  ┌─────────────────────────────────────────────┐            │
│  │              API 适配器接口                  │            │
│  └─────────────────────────────────────────────┘            │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           │                               │
           ▼                               ▼
┌─────────────────────┐         ┌─────────────────────┐
│      主应用          │         │   局域网共享前端     │
│                     │         │                     │
│  TauriAdapter       │         │  HttpAdapter        │
│  (Tauri API 实现)   │         │  (HTTP API 实现)    │
└─────────────────────┘         └─────────────────────┘
```

---

## 实施阶段

### 第一阶段：基础设施搭建（低风险）

#### 1.1 创建共享目录结构
```
src/shared/
├── components/
│   ├── UI/
│   │   ├── Button.tsx
│   │   ├── LoadingSpinner.tsx
│   │   ├── EmptyPlaceholder.tsx
│   │   └── index.ts
│   └── index.ts
├── hooks/
│   ├── useInView.ts
│   ├── useImageTransform.ts
│   └── index.ts
├── utils/
│   ├── debounce.ts
│   ├── cache.ts
│   └── index.ts
├── api/
│   ├── types.ts              # API 接口类型定义
│   ├── adapters/
│   │   ├── TauriAdapter.ts
│   │   ├── HttpAdapter.ts
│   │   └── index.ts
│   └── index.ts
├── types/
│   ├── file.ts
│   ├── image.ts
│   └── index.ts
└── index.ts
```

#### 1.2 提取工具函数
- [ ] 将 `src/utils/debounce.ts` 复制到 `src/shared/utils/debounce.ts`
- [ ] 将 `src/utils/thumbnailCache.ts` 中的 LRU 缓存逻辑提取到 `src/shared/utils/cache.ts`

#### 1.3 提取 Hooks
- [ ] 将 `src/hooks/useInView.ts` 移动到 `src/shared/hooks/useInView.ts`
- [ ] 创建 `useImageTransform.ts`（从 ImageViewer 提取图片变换逻辑）

#### 1.4 定义 API 接口类型
- [ ] 创建 `src/shared/api/types.ts`，定义：
  - `ImageApi` - 图片相关接口
  - `FileApi` - 文件操作接口
  - `SharedApi` - 完整 API 接口

---

### 第二阶段：UI 组件层（中风险）

#### 2.1 提取基础 UI 组件
- [ ] 创建 `LoadingSpinner.tsx` - 加载指示器
- [ ] 创建 `EmptyPlaceholder.tsx` - 空状态占位
- [ ] 创建 `BreadcrumbNav.tsx` - 面包屑导航

#### 2.2 提取缩略图组件
- [ ] 创建 `ImageThumbnail.tsx` - 图片缩略图（抽象 API）
- [ ] 创建 `FolderThumbnail.tsx` - 文件夹缩略图

#### 2.3 创建虚拟滚动网格
- [ ] 从 FileGrid 提取虚拟滚动逻辑到 `VirtualGrid.tsx`
- [ ] 创建 `GridItem.tsx` - 网格项组件

---

### 第三阶段：核心组件层（高风险）

#### 3.1 图片查看器核心
- [ ] 创建 `ImageViewerCore.tsx` - 纯 UI 组件
- [ ] 创建 `ImageViewerControls.tsx` - 控制按钮
- [ ] 提取幻灯片逻辑到 `SlideshowManager.tsx`

#### 3.2 API 适配器实现
- [ ] 实现 `TauriAdapter.ts` - 主应用 API 适配器
- [ ] 实现 `HttpAdapter.ts` - 局域网共享 API 适配器

---

### 第四阶段：重构现有组件

#### 4.1 重构主应用组件
- [ ] 修改 `FileGrid.tsx` 使用共享组件
- [ ] 修改 `ImageViewer.tsx` 使用共享组件
- [ ] 更新导入路径

#### 4.2 重构局域网共享前端
- [ ] 修改 `BrowseScreen.tsx` 使用共享组件
- [ ] 修改 `ImageViewer.tsx` 使用共享组件
- [ ] 更新 API 调用方式

---

### 第五阶段：构建配置更新

#### 5.1 更新 Tailwind 配置
- [ ] 修改 `tailwind.config.js`，添加 `src/shared/**/*` 到 content

#### 5.2 更新 Vite 配置
- [ ] 修改 `vite.config.lan-share.ts`，确保能解析共享组件

#### 5.3 测试验证
- [ ] 主应用构建测试
- [ ] 局域网共享构建测试
- [ ] 功能完整性测试

---

## API 适配器接口设计

```typescript
// src/shared/api/types.ts

export interface ImageApi {
  getImageUrl(path: string): string;
  getThumbnailUrl(path: string, signal?: AbortSignal): string | Promise<string>;
  getAnimationData?(path: string): Promise<string | null>;
  getSpecialFormatPreview?(path: string, format: 'jxl' | 'avif'): Promise<string>;
}

export interface FileApi {
  deleteFile(path: string): Promise<void>;
  renameFile(oldPath: string, newPath: string): Promise<void>;
}

export interface ExtendedApi {
  getDominantColors?(path: string, count: number): Promise<DominantColor[]>;
  startDragExternal?(paths: string[], thumbnails: string[]): Promise<void>;
  copyToClipboard?(path: string): Promise<void>;
}

export interface SharedApi extends ImageApi, FileApi, ExtendedApi {}
```

---

## 文件变更清单

### 新建文件

| 文件路径 | 说明 |
|---------|------|
| `src/shared/index.ts` | 共享库入口 |
| `src/shared/api/types.ts` | API 接口类型 |
| `src/shared/api/adapters/TauriAdapter.ts` | Tauri 适配器 |
| `src/shared/api/adapters/HttpAdapter.ts` | HTTP 适配器 |
| `src/shared/hooks/useImageTransform.ts` | 图片变换 hook |
| `src/shared/components/UI/LoadingSpinner.tsx` | 加载指示器 |
| `src/shared/components/UI/EmptyPlaceholder.tsx` | 空状态占位 |
| `src/shared/components/UI/BreadcrumbNav.tsx` | 面包屑导航 |
| `src/shared/components/Thumbnails/ImageThumbnail.tsx` | 图片缩略图 |
| `src/shared/components/Thumbnails/FolderThumbnail.tsx` | 文件夹缩略图 |
| `src/shared/components/Grid/VirtualGrid.tsx` | 虚拟滚动网格 |
| `src/shared/components/ImageViewer/ImageViewerCore.tsx` | 图片查看器核心 |

### 修改文件

| 文件路径 | 说明 |
|---------|------|
| `tailwind.config.js` | 添加 shared 目录到 content |
| `vite.config.lan-share.ts` | 更新构建配置 |
| `src/components/FileGrid.tsx` | 使用共享组件 |
| `src/components/ImageViewer.tsx` | 使用共享组件 |
| `src/lan-share/components/BrowseScreen.tsx` | 使用共享组件 |
| `src/lan-share/components/ImageViewer.tsx` | 使用共享组件 |

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 重构影响现有功能 | 高 | 分阶段实施，每阶段完成后测试 |
| API 抽象不完整 | 中 | 先定义完整接口，再实现适配器 |
| 构建配置问题 | 低 | 逐步验证构建流程 |
| 性能下降 | 低 | 共享组件保持相同的优化策略 |

---

## 预期成果

1. **UI 完全统一** - 主应用和局域网共享前端使用相同的组件
2. **代码复用率 60-70%** - 减少重复代码
3. **维护成本降低** - 改一处，两边同步更新
4. **扩展性增强** - 未来新增功能只需实现一次

---

## 时间估算

| 阶段 | 预计工作量 |
|------|-----------|
| 第一阶段：基础设施 | 1-2 小时 |
| 第二阶段：UI 组件 | 2-3 小时 |
| 第三阶段：核心组件 | 3-4 小时 |
| 第四阶段：重构 | 2-3 小时 |
| 第五阶段：测试验证 | 1-2 小时 |
| **总计** | **9-14 小时** |

---

**计划版本**: 1.0  
**创建日期**: 2026-03-12
