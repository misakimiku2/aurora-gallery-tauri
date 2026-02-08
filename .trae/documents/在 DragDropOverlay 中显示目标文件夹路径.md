## 任务概述
在 DragDropOverlay 组件中，在"将文件复制到"提示下方新增显示目标文件夹路径，让用户知道文件将被复制到哪个位置。

## 实现方案

### 1. 修改 `DragDropOverlay.tsx`

**新增 Props:**
- `targetPath: string` - 目标文件夹路径

**修改内容:**
在显示 `t('context.copy')`（"复制"）大标题的区域下方，新增一行显示目标文件夹路径。

### 2. 修改 `App.tsx`

**传递目标路径给 DragDropOverlay:**
根据 `activeTab.folderId` 获取当前文件夹的路径，传递给 DragDropOverlay 组件。

```tsx
// 获取目标文件夹路径
const targetFolder = state.files[activeTab.folderId];
const targetPath = targetFolder?.path || '';

// 传递给 DragDropOverlay
<DragDropOverlay
  isVisible={isExternalDragging && !activeTab.isCompareMode}
  fileCount={externalDragItems.length}
  hoveredAction={hoveredDropAction}
  onHoverAction={setHoveredDropAction}
  t={t}
  targetPath={targetPath}
/>
```

### 3. UI 设计

在 DragDropOverlay 中，在文件数量统计下方新增目标路径显示：
- 使用较小的字体和灰色颜色
- 显示文件夹图标 + 路径文本
- 路径过长时显示省略号

**修改位置:** DragDropOverlay.tsx 第 93-104 行区域，在文件数量统计下方添加路径显示。

### 文件修改清单
1. `src/components/DragDropOverlay.tsx` - 添加 targetPath prop 和 UI 显示
2. `src/App.tsx` - 传递 targetPath 给 DragDropOverlay