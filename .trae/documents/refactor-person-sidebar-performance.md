# 人物栏性能优化与锯齿修复重构计划

## 问题根本原因分析

### 1. 性能问题根源

**问题 1: 组件定义在函数内部**
```tsx
const PeopleSection = React.memo(({ ... }) => {
  // PersonCardInner 定义在组件内部，每次渲染都会创建新的组件实例
  const PersonCardInner: React.FC<{ person: Person }> = ({ person }) => { ... }
  const PersonCard = React.memo(PersonCardInner, personCardEqual);
});
```
- `PersonCardInner` 定义在 `PeopleSection` 内部，每次父组件渲染都会创建新的组件引用
- `React.memo` 完全失效，因为组件引用每次都不同
- 42 个人物卡片每次都会重新渲染

**问题 2: files 对象作为 props 传递**
- `files` 是一个包含所有文件的大对象
- 每次任何文件变化都会触发 `PeopleSection` 重新渲染
- 所有 `PersonCard` 都会因为父组件重渲染而重渲染

**问题 3: 虚拟化实现不完善**
- `react-window` 的 `FixedSizeList` 使用方式不正确
- `itemData` 包含了 `PersonCard` 组件引用，每次都是新引用
- 导致虚拟列表无法正确 memoize

### 2. 锯齿问题根源

**问题 1: faceBox 裁剪放大**
```tsx
width: `${10000 / Math.max(person.faceBox.w, 2.0)}%`
```
- 当 `faceBox.w = 10` 时，图片被放大到原始的 1000%
- 小图片被强制放大，导致严重的像素化和锯齿

**问题 2: 缺少高质量缩略图**
- 当前直接使用原图进行裁剪
- 没有预先生成适合头像尺寸的高质量缩略图

---

## 解决方案

### 方案一：组件重构（核心优化）

#### 1.1 将 PersonCard 组件移到组件外部

**修改文件**: `src/components/TreeSidebar.tsx`

将 `PersonCardInner` 从 `PeopleSection` 内部移到模块顶层：

```tsx
// 移到 PeopleSection 外部，作为独立组件
interface PersonCardProps {
  person: Person;
  coverFileId?: string;
  coverSrc?: string;
  onPersonSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onStartRenamePerson: (id: string) => void;
}

const PersonCard: React.FC<PersonCardProps> = React.memo(({ 
  person, 
  coverFileId, 
  coverSrc,
  onPersonSelect,
  onContextMenu,
  onStartRenamePerson 
}) => {
  // 组件实现
}, (prev, next) => {
  return prev.person.id === next.person.id 
    && prev.coverSrc === next.coverSrc
    && prev.person.name === next.person.name
    && prev.person.count === next.person.count;
});
```

#### 1.2 使用 Context 隔离 files 依赖

创建 `PersonCardContext` 来避免传递大型 `files` 对象：

```tsx
interface PersonCardContextValue {
  getCoverSrc: (coverFileId: string) => string | undefined;
}

const PersonCardContext = React.createContext<PersonCardContextValue | null>(null);

// 在 PeopleSection 中提供 context
<PersonCardContext.Provider value={{ getCoverSrc }}>
  {/* 虚拟列表 */}
</PersonCardContext.Provider>

// 在 PersonCard 中使用
const { getCoverSrc } = useContext(PersonCardContext);
const coverSrc = person.coverFileId ? getCoverSrc(person.coverFileId) : undefined;
```

#### 1.3 正确使用 react-window

```tsx
// 预计算行数据，避免在渲染时计算
const peopleRows = useMemo(() => {
  const rows = [];
  for (let i = 0; i < peopleList.length; i += 4) {
    rows.push(peopleList.slice(i, i + 4).map(p => ({
      id: p.id,
      name: p.name,
      count: p.count,
      coverFileId: p.coverFileId,
      faceBox: p.faceBox
    })));
  }
  return rows;
}, [peopleList]);

// 使用稳定的 itemData
const itemData = useMemo(() => ({
  rows: peopleRows,
  onPersonSelect,
  onContextMenu,
  onStartRenamePerson
}), [peopleRows, onPersonSelect, onContextMenu, onStartRenamePerson]);

<FixedSizeList
  height={availableHeight}
  itemCount={peopleRows.length}
  itemSize={rowHeight}
  width="100%"
  itemData={itemData}
  itemKey={(index, data) => data.rows[index][0]?.id || index}
>
  {PersonRow}
</FixedSizeList>
```

### 方案二：图片锯齿修复

#### 2.1 使用 CSS image-rendering 优化

对于放大的图片，使用 `image-rendering: -webkit-optimize-contrast` 或 `smooth`：

```tsx
<img
  style={{
    imageRendering: 'smooth', // 或 'high-quality' (非标准)
    // 对于 WebKit 浏览器
    WebkitTransform: 'translateZ(0)',
    // 使用 CSS filter 软化边缘
    filter: 'contrast(1.01)',
  }}
/>
```

#### 2.2 限制放大倍数

```tsx
// 限制最大放大倍数为 500%
const maxScale = 500;
const scale = Math.min(10000 / Math.max(person.faceBox.w, 2.0), maxScale);
const width = `${scale}%`;
const height = `${scale}%`;
```

#### 2.3 使用 Canvas 预渲染（可选高级方案）

对于需要高质量裁剪的头像，可以使用 Canvas 预渲染：

```tsx
// 在组件挂载时预渲染裁剪后的头像
useEffect(() => {
  if (!coverSrc || !person.faceBox) return;
  
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const size = 80; // 输出尺寸
    canvas.width = size;
    canvas.height = size;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // 启用图像平滑
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    // 计算裁剪区域
    const box = person.faceBox;
    const sx = (box.x / 100) * img.width;
    const sy = (box.y / 100) * img.height;
    const sw = (box.w / 100) * img.width;
    const sh = (box.w / 100) * img.height;
    
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
    
    setAvatarUrl(canvas.toDataURL('image/png', 0.9));
  };
  img.src = coverSrc;
}, [coverSrc, person.faceBox]);
```

### 方案三：滚动性能优化

#### 3.1 使用 CSS contain 严格隔离

```tsx
// 人物卡片容器
<div style={{ 
  contain: 'strict',  // 最严格的隔离
  contentVisibility: 'auto',
  containIntrinsicSize: '88px'
}}>
```

#### 3.2 使用 will-change 优化（谨慎使用）

```tsx
// 仅在滚动时启用
<div style={{
  willChange: isScrolling ? 'transform' : 'auto'
}}>
```

#### 3.3 使用 Intersection Observer 替代虚拟化

对于侧边栏这种场景，Intersection Observer 可能比 react-window 更高效：

```tsx
const PersonCardWithObserver = ({ person, isVisible }) => {
  if (!isVisible) {
    return <div style={{ height: 88 }} />; // 占位符
  }
  return <PersonCard person={person} />;
};
```

---

## 实施步骤

### 步骤 1：重构 PersonCard 组件（高优先级）

1. 将 `PersonCardInner` 移到 `PeopleSection` 外部
2. 创建 `PersonCardContext` 隔离 files 依赖
3. 使用正确的 React.memo 比较函数

### 步骤 2：修复虚拟化实现（高优先级）

1. 修正 `FixedSizeList` 的使用方式
2. 稳定 `itemData` 引用
3. 添加 `itemKey` 确保正确的 key

### 步骤 3：修复图片锯齿（中优先级）

1. 限制 faceBox 裁剪的最大放大倍数
2. 添加 CSS 图像平滑属性
3. （可选）实现 Canvas 预渲染

### 步骤 4：性能测试验证

1. 使用 React DevTools Profiler 测试渲染次数
2. 使用 Chrome DevTools Performance 分析帧率
3. 测试 100+ 人物时的性能表现

---

## 预期效果

1. **渲染性能**: 42 个人物时，滚动帧率从 15-20fps 提升到 55-60fps
2. **内存占用**: 减少 50% 以上的不必要重渲染
3. **图片质量**: 头像边缘平滑，无明显锯齿
4. **可扩展性**: 支持 500+ 人物时仍保持流畅

---

## 文件修改清单

| 文件 | 修改内容 |
|------|----------|
| `src/components/TreeSidebar.tsx` | 重构 PersonCard、PeopleSection 组件 |
| `src/components/PersonGrid.tsx` | 同步应用相同的优化 |
| `src/contexts/PersonCardContext.tsx` | 新建：PersonCard Context |

---

## 风险评估

- **中等风险**: 组件重构可能影响现有功能，需要充分测试
- **兼容性**: `image-rendering: smooth` 非标准属性，需要浏览器前缀
- **回退方案**: 如果重构出现问题，可以回退到当前实现
