# 拖拽功能完整实现文档

## 概述

本文档记录了 Aurora Gallery Tauri 应用中完整的拖拽功能实现，包括：
- 内部拖拽（软件内文件移动）
- 外部拖拽（从软件拖出文件到外部应用）
- 外部拖入（从外部拖入文件到软件）
- 拖拽预览图生成
- 用户提示和交互

## 功能架构

### 1. 内部拖拽（HTML5 Drag API）

**用途**：在软件内部移动文件到文件夹

**实现位置**：`src/components/FileGrid.tsx`

**关键配置**：
- `tauri.conf.json` 中 `dragDropEnabled: false`（必须设置为 false，否则会出现禁止标识）

**实现方式**：
- 使用 HTML5 原生 `dragstart` 事件
- 设置 `application/json` 数据格式，包含 `internalDrag: true` 标记
- 设置 `text/uri-list` 格式用于外部兼容
- 动态创建 DOM 元素作为拖拽预览图

**关键代码**：
```typescript
// 在 handleDragStart 中
e.dataTransfer.setData('application/json', JSON.stringify({
  type: 'file',
  ids: filesToDrag,
  sourceFolderId: file.parentId,
  internalDrag: true // 内部拖拽标记
}));
```

**DOM 预览实现**：
- 动态创建 DOM 元素作为拖拽预览
- 响应式拖拽缩略图尺寸计算（主界面图标大小范围：100px-480px，拖拽缩略图大小范围：100px-380px）
- 堆叠效果：最多显示3个缩略图，每个缩略图独立旋转和偏移
- 使用缓存的缩略图，未加载时显示占位符（图片、文件夹3D图标、其他文件类型）
- 超过3个文件时显示计数徽章

**堆叠效果实现**：
```typescript
// 计算位置和旋转（使用CSS变换）
const rotation = i === 0 ? 0 : (i === 1 ? -8 : 8);
const offsetScale = singleThumbSize / 150;
const offsetX = i === 0 ? 0 : (i === 1 ? -10 * offsetScale : 10 * offsetScale);
const offsetY = i * 12 * offsetScale;
thumbElement.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg)`;
```

### 2. 外部拖拽（tauri-plugin-drag）

**用途**：从软件拖出文件到外部应用（如文件管理器、聊天软件等）

**触发方式**：按住 `Alt` 键 + 鼠标左键拖拽

**实现位置**：
- 前端：`src/components/FileGrid.tsx` (onMouseDown 处理器)
- API：`src/api/tauri-bridge.ts` (startDragToExternal 函数)
- Rust：`src-tauri/src/main.rs` (generate_drag_preview 命令)

**依赖**：
- `tauri-plugin-drag` (Rust 和 JS)
- `@crabnebula/tauri-plugin-drag` (npm)

**实现流程**：
1. 检测 `Alt` 键按下
2. 收集要拖拽的文件路径
3. 获取缩略图路径（最多3个）
4. 调用 Rust 后端生成组合预览图
5. 使用 `tauri-plugin-drag` 的 `startDrag` 启动拖拽

**关键代码**：
```typescript
// FileGrid.tsx - onMouseDown
if (e.altKey && isTauriEnvironment()) {
  e.preventDefault();
  // 收集文件路径和缩略图路径
  const filePaths = filesToDrag.map(...);
  const thumbnailPaths = filePaths.slice(0, 3).map(...);
  
  // 调用拖拽函数
  await startDragToExternal(filePaths, thumbnailPaths, cacheDir, () => {
    setIsDragging(false);
    setIsDraggingInternal(false);
  });
}
```

**预览图生成**：
- Rust 端生成 128x128 的 PNG 预览图
- 最多显示 3 个缩略图的堆叠效果
- 右下角显示蓝色圆形徽章，显示文件总数
- 使用位图字体绘制数字（0-9）

### 3. 外部拖入（DragDropOverlay）

**用途**：从外部应用拖入文件到软件，复制到当前文件夹

**实现位置**：
- 组件：`src/components/DragDropOverlay.tsx`
- 事件处理：`src/App.tsx` (handleExternalDragEnter, handleExternalDrop)

**检测机制**：
- 检查 `e.dataTransfer.types.includes('Files')`
- 排除内部拖拽：检查 `e.dataTransfer.types.includes('application/json')` 或 `isDraggingInternal` 状态

**关键代码**：
```typescript
// App.tsx - handleExternalDragEnter
const isInternalDrag = e.dataTransfer.types.includes('application/json') || isDraggingInternal;

if (e.dataTransfer.types.includes('Files') && !isInternalDrag) {
  setIsExternalDragging(true);
  // 显示覆盖层
}
```

**覆盖层设计**：
- 单一复制区域（蓝色主题）
- 悬停时高亮显示
- 显示文件数量
- 提示文字："将文件复制到"

### 4. 拖拽预览图生成（Rust 端）

**实现位置**：`src-tauri/src/main.rs` - `generate_drag_preview` 命令

**功能**：
- 接收缩略图路径数组（最多3个）
- 接收总文件数
- 生成 128x128 的 PNG 预览图
- 堆叠显示多个缩略图
- 右下角显示文件数量徽章

**实现细节**：
```rust
// 预览图尺寸
const PREVIEW_SIZE: u32 = 128;
const THUMB_SIZE: u32 = 100;
const BORDER_WIDTH: u32 = 2;

// 堆叠效果
let offset_x = match i {
    0 => (PREVIEW_SIZE - THUMB_SIZE) / 2,
    1 => (PREVIEW_SIZE - THUMB_SIZE) / 2 - 8,
    _ => (PREVIEW_SIZE - THUMB_SIZE) / 2 + 8,
};
let offset_y = (PREVIEW_SIZE - THUMB_SIZE) / 2 + (i as u32) * 6;

// 数字绘制（位图字体）
let digit_bitmaps: [[[u8; 5]; 7]; 10] = [
    // 0-9 的位图定义
];
```

**依赖**：
- `image` crate (0.24)
- `ab_glyph` 和 `ab_glyph_rasterizer` (用于字体渲染，但实际使用位图字体)

### 5. 多文件选择提示

**用途**：当用户选择多个文件时，提示可以使用 Alt+拖拽功能

**实现位置**：`src/App.tsx`

**实现方式**：
- 监听 `activeTab.selectedFileIds.length`
- 当选择数量 > 1 时显示提示
- 提示消息持久显示，直到选择数量 <= 1

**关键代码**：
```typescript
const selectedCount = activeTab.selectedFileIds.length;
const showDragHint = selectedCount > 1;

// UI 渲染
{showDragHint && (
  <div className="bg-blue-600 dark:bg-blue-700 text-white text-sm px-4 py-2.5 rounded-full shadow-lg backdrop-blur-sm animate-toast-up flex items-center gap-2 pointer-events-auto">
    <span>{t('drag.multiSelectHint')}</span>
  </div>
)}
```

**翻译文本**：
- 中文：`"按住 Alt + 鼠标左键拖拽可将文件复制到外部"`
- 英文：`"Hold Alt + Left Mouse Button to drag files outside"`

## 配置文件

### tauri.conf.json
```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "dragDropEnabled": false  // 必须为 false，否则内部拖拽会出现禁止标识
      }
    ]
  }
}
```

### src-tauri/Cargo.toml
```toml
[dependencies]
tauri-plugin-drag = "2"
ab_glyph = "0.2"
ab_glyph_rasterizer = "0.1"
```

### package.json
```json
{
  "devDependencies": {
    "@crabnebula/tauri-plugin-drag": "^2.1.0"
  }
}
```

### src-tauri/capabilities/default.json
```json
{
  "permissions": [
    "drag:default",
    "drag:allow-start-drag"
  ]
}
```

## 状态管理

### 关键状态变量

**App.tsx**：
- `isExternalDragging`: 是否正在外部拖入
- `externalDragItems`: 外部拖入的文件列表
- `hoveredDropAction`: 悬停的操作（copy/null）
- `isDraggingInternal`: 是否正在进行内部拖拽（用于区分内部/外部拖拽）

**FileGrid.tsx**：
- `isDragging`: 文件卡片拖拽状态（FileCard）
- `isExternalDragging`: 列表项拖拽状态（FileListItem）

## 关键函数

### 前端 API (`src/api/tauri-bridge.ts`)

1. **`generateDragPreview`**
   - 调用 Rust 后端生成拖拽预览图
   - 参数：缩略图路径数组、总文件数、缓存目录
   - 返回：预览图文件路径

2. **`startDragToExternal`**
   - 启动外部拖拽操作
   - 参数：文件路径数组、缩略图路径数组、缓存目录、回调函数
   - 使用 `tauri-plugin-drag` 的 `startDrag`

### Rust 后端 (`src-tauri/src/main.rs`)

1. **`generate_drag_preview`**
   - 生成拖拽预览图
   - 组合多个缩略图
   - 绘制文件数量徽章

## 问题解决记录

### 问题1：内部拖拽时出现禁止标识
**原因**：`dragDropEnabled: true` 时，Tauri 会拦截拖拽事件
**解决**：设置为 `false`，使用 HTML5 Drag API

### 问题2：外部拖拽时显示原始大图
**原因**：`tauri-plugin-drag` 默认使用原始文件作为图标
**解决**：生成组合预览图，传递预览图路径作为图标

### 问题3：Alt+拖拽时覆盖层出现
**原因**：`tauri-plugin-drag` 触发系统级拖拽，被检测为外部拖入
**解决**：在 Alt+拖拽时设置 `isDraggingInternal` 状态，在检测外部拖入时排除

### 问题4：移动操作实际上是复制
**原因**：浏览器安全限制，无法获取外部文件的原始路径
**解决**：移除移动选项，只保留复制功能

## 实现优化特点

### 1. 稳定性和可靠性
- ✅ 避免了 Canvas 绘制的时序问题
- ✅ 解决了异步图片加载导致的预览为空问题
- ✅ 拖拽过程中预览始终跟随鼠标指针
- ✅ DOM 元素动态清理，避免内存泄漏

### 2. 性能优化
- ✅ 直接使用已缓存的缩略图，无需重新加载
- ✅ 优化的 CSS 变换，GPU 加速渲染
- ✅ Rust 端预览图生成，减少前端计算

### 3. 视觉效果
- ✅ 堆叠的缩略图效果，最多显示3个
- ✅ 每个缩略图独立旋转和偏移
- ✅ 响应式设计，拖拽缩略图大小与主界面图标大小成比例
- ✅ 精美的 3D 文件夹占位符
- ✅ 超过3个文件时显示计数徽章（内部拖拽）或总数徽章（外部拖拽）

### 4. 兼容性
- ✅ 完全兼容所有现代浏览器
- ✅ 支持 Tauri 应用环境
- ✅ 内部拖拽无需特殊 API 支持

## 测试要点

1. **内部拖拽**：
   - 拖拽文件到文件夹
   - 拖拽多个文件
   - 拖拽不同类型的文件（图片、文件夹）
   - 验证堆叠预览效果
   - 验证计数徽章显示

2. **外部拖拽**：
   - Alt+拖拽单个文件
   - Alt+拖拽多个文件
   - 检查预览图是否正确显示
   - 检查文件数量徽章

3. **外部拖入**：
   - 从文件管理器拖入文件
   - 从其他应用拖入文件
   - 检查覆盖层是否正确显示
   - 检查文件是否正确复制

4. **提示消息**：
   - 选择多个文件时显示提示
   - 选择数量减少到 <= 1 时隐藏
   - 提示消息持久显示

## 相关文件

- `src/components/FileGrid.tsx` - 拖拽事件处理（内部拖拽 DOM 预览实现）
- `src/components/DragDropOverlay.tsx` - 外部拖入覆盖层
- `src/api/tauri-bridge.ts` - 拖拽 API
- `src/App.tsx` - 外部拖入事件处理
- `src-tauri/src/main.rs` - 预览图生成
- `src/utils/translations.ts` - 翻译文本

---

**最后更新**：2025-01-27
**实现状态**：✅ 已完成
