# 标签索引栏重新设计方案

## 问题分析

当前标签索引栏的实现问题：
1. **垂直布局溢出**：索引项垂直排列，当数量过多时超出视口
2. **位置固定**：悬浮在右侧，占用额外空间
3. **滚动方案效果不佳**：之前尝试添加滚动，用户体验不理想

## 新设计方案

### 设计理念
将索引栏从右侧垂直布局改为**工具栏下方的水平刻度条**，类似字母导航条的设计。

### 布局位置
放在 `h-14` 工具栏下方（App.tsx 第 4614 行），作为标签视图专属的导航条。

### 核心功能
1. **水平刻度展示**：字母索引水平排列，紧凑显示
2. **当前位置高亮**：根据滚动位置高亮当前所在的字母分组
3. **点击跳转**：点击字母快速滚动到对应分组
4. **仅在标签视图显示**：只在 `viewMode === 'tags-overview'` 时显示

## 实现步骤

### 步骤 1：在 App.tsx 中添加新的索引栏组件

位置：工具栏 div 闭合标签后，`flex-1 overflow-hidden` 容器前

```tsx
{/* 标签索引刻度条 - 仅在标签视图显示 */}
{activeTab.viewMode === 'tags-overview' && (
  <TagIndexBar 
    keys={Object.keys(groupedTags || {}).sort()}
    scrollTop={scrollTop}
    layout={tagLayout}
  />
)}
```

### 步骤 2：创建 TagIndexBar 组件

在 TagsList.tsx 中创建新组件：

```tsx
interface TagIndexBarProps {
  keys: string[];
  scrollTop: number;
  layout: LayoutItem[];
}

const TagIndexBar: React.FC<TagIndexBarProps> = ({ keys, scrollTop, layout }) => {
  // 计算当前高亮的字母
  const activeKey = useMemo(() => {
    const headerItems = layout.filter(item => item.id.startsWith('header:'));
    for (let i = headerItems.length - 1; i >= 0; i--) {
      if (scrollTop >= headerItems[i].y - 100) {
        return headerItems[i].id.replace('header:', '');
      }
    }
    return headerItems[0]?.id.replace('header:', '') || '';
  }, [scrollTop, layout]);

  const scrollToGroup = (group: string) => {
    const headerItem = layout.find(item => item.id === `header:${group}`);
    if (headerItem) {
      const container = document.getElementById('file-grid-container');
      if (container) {
        container.scrollTo({ top: headerItem.y, behavior: 'smooth' });
      }
    }
  };

  return (
    <div className="h-8 flex items-center px-4 gap-1 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 backdrop-blur shrink-0 relative z-10 overflow-x-auto">
      {keys.map((key) => (
        <button
          key={key}
          onClick={() => scrollToGroup(key)}
          className={`min-w-[24px] h-6 px-1.5 rounded-md flex items-center justify-center text-xs font-medium transition-all ${
            activeKey === key
              ? 'bg-blue-500 text-white shadow-sm scale-110'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {key}
        </button>
      ))}
    </div>
  );
};
```

### 步骤 3：移除 TagsList.tsx 中原有的右侧索引栏

删除第 237-277 行的 createPortal 索引栏代码。

### 步骤 4：传递必要的 props

在 App.tsx 中调用 TagsList 时，需要传递 `scrollTop` 和 `layout` 给新的 TagIndexBar。

## 样式细节

### 索引条容器
- 高度：`h-8`（32px）
- 背景：`bg-gray-50/50 dark:bg-gray-900/50`
- 边框：`border-b border-gray-100 dark:border-gray-800`
- 滚动：`overflow-x-auto` 支持水平滚动

### 索引按钮
- 最小宽度：`min-w-[24px]`
- 高度：`h-6`
- 激活状态：蓝色背景 + 白色文字 + 放大效果
- 普通状态：灰色文字 + hover 效果

## 优势

1. **不占用垂直空间**：水平布局，不会超出视口
2. **直观的当前位置**：高亮显示当前所在分组
3. **紧凑设计**：每个按钮仅 24px 宽，可容纳大量索引
4. **符合 UI 规范**：与工具栏风格一致
5. **支持水平滚动**：索引过多时可滚动查看

## 文件修改清单

| 文件 | 修改内容 |
|------|----------|
| `src/App.tsx` | 添加 TagIndexBar 组件，传递 props |
| `src/components/TagsList.tsx` | 创建 TagIndexBar 组件，移除原有索引栏 |
