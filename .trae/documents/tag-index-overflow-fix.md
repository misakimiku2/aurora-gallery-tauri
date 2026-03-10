# 标签索引栏溢出问题修复计划

## 问题分析

当前标签索引栏的实现存在以下问题：

1. **固定居中定位**：索引栏使用 `fixed` 定位 + `translate-y-1/2` 实现垂直居中
2. **无高度限制**：没有设置最大高度，当索引项过多时会超出视口
3. **无滚动支持**：超出部分无法滚动查看
4. **窗口高度 800px 时**：假设每个按钮高度约 28px（h-6 + space-y-1），加上 padding，大约 20 个索引项就会超出

## 解决方案

### 方案：添加滚动支持 + 动态高度限制

修改 `TagsList.tsx` 中的索引栏组件：

1. **设置最大高度**：`max-h-[calc(100vh-40px)]` 确保不超出视口
2. **添加滚动功能**：`overflow-y-auto` 支持滚动
3. **优化按钮尺寸**：减小按钮尺寸以容纳更多内容（可选）
4. **动态调整位置**：确保索引栏不会超出视口上下边界

## 实现步骤

### 步骤 1：修改索引栏容器样式

文件：`src/components/TagsList.tsx`

修改第 239 行的 div 样式：
- 添加 `max-h-[calc(100vh-40px)]` 限制最大高度
- 添加 `overflow-y-auto` 支持滚动
- 添加自定义滚动条样式隐藏滚动条或美化

### 步骤 2：优化按钮尺寸（可选）

减小按钮尺寸从 `w-6 h-6` 改为 `w-5 h-5`，字体从 `text-xs` 保持不变，减少间距 `space-y-0.5`

### 步骤 3：添加智能定位逻辑

修改 `computeIndexTop` 函数，确保：
- 索引栏顶部不会超出视口上边界
- 索引栏底部不会超出视口下边界
- 当内容超出时，优先显示顶部或底部的索引

## 具体代码修改

### 修改 1：索引栏容器（第 238-277 行）

```tsx
{filteredKeys.length > 0 && createPortal(
  <div 
    className="fixed transform -translate-y-1/2 z-[110] bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm rounded-full px-1 py-2 shadow-md border border-gray-200 dark:border-gray-800 transition-all duration-300 max-h-[calc(100vh-40px)] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700 scrollbar-track-transparent"
    style={{ 
      right: 'calc(20px + var(--metadata-panel-width, 0px))', 
      top: indexTop != null ? `${indexTop}px` : '50%'
    }}
    onMouseEnter={() => {
      const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
      if (metadataPanel) {
        metadataPanel.style.zIndex = '10';
      }
    }}
    onMouseLeave={() => {
      const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
      if (metadataPanel) {
        metadataPanel.style.zIndex = '40';
      }
    }}
  >
    <div className="flex flex-col items-center space-y-0.5">
      {filteredKeys.map((group: string) => (
        <button
          key={group}
          onClick={() => {
            const headerItem = layout.find(item => item.id === `header:${group}`);
            if (headerItem) {
              const container = document.getElementById('file-grid-container'); 
              if (container) {
                container.scrollTo({ top: headerItem.y, behavior: 'smooth' });
              }
            }
          }}
          className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium text-gray-600 dark:text-gray-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-400 transition-colors flex-shrink-0"
          title={group}
        >
          {group}
        </button>
      ))}
    </div>
  </div>,
  (typeof document !== 'undefined' ? document.body : null) as Element
)}
```

### 修改 2：添加滚动条样式（可选，在全局 CSS 中）

如果需要美化滚动条，可以在全局 CSS 中添加：

```css
.scrollbar-thin {
  scrollbar-width: thin;
}
.scrollbar-thumb-gray-300::-webkit-scrollbar-thumb {
  background-color: #d1d5db;
  border-radius: 9999px;
}
.scrollbar-track-transparent::-webkit-scrollbar-track {
  background-color: transparent;
}
```

## 预期效果

- 窗口高度 800px 时，索引栏最大高度约为 760px
- 假设每个按钮高度约 22px（w-5 h-5 + space-y-0.5），可显示约 34 个索引项
- 超出部分可通过滚动查看
- 滚动条细小美观，不影响整体视觉效果
