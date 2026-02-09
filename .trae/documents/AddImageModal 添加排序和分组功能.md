## 实施计划

### 1. 修改 AddImageModal.tsx

**A. 添加必要的导入**
- 从 lucide-react 导入排序和分组相关图标（ArrowUpDown, Layers 等）

**B. 定义类型和常量**
- 添加 `SortByOption` 类型: 'name' | 'date' | 'size'
- 添加 `GroupByOption` 类型: 'none' | 'type' | 'date' | 'size'
- 添加 localStorage key 常量

**C. 添加状态**
- `sortBy`: 当前排序方式
- `sortDirection`: 排序方向 (asc/desc)
- `groupBy`: 当前分组方式
- `showSortMenu`: 是否显示排序下拉菜单
- `showGroupMenu`: 是否显示分组下拉菜单

**D. 从 localStorage 读取/保存设置**
- 组件挂载时从 localStorage 读取保存的设置
- 设置改变时保存到 localStorage

**E. 实现排序逻辑**
- 在 `allDisplayedImages` useMemo 中添加排序逻辑
- 按名称：使用 localeCompare
- 按时间：使用 updatedAt 或 createdAt
- 按大小：使用 meta.sizeKb

**F. 实现分组逻辑**
- 添加 `groupedImages` useMemo 计算分组后的数据
- 按类型：根据文件扩展名分组
- 按日期：根据 updatedAt 的日期部分分组
- 按大小：根据大小范围分组（如 <100KB, 100KB-1MB, >1MB）

**G. 修改渲染逻辑**
- 替换原有的全选/清除按钮为排序和分组图标按钮
- 添加下拉菜单组件用于选择排序和分组选项
- 修改图片网格渲染，支持分组标题显示

**H. 添加国际化支持**
- 添加相关翻译 key 到翻译文件

### 2. UI 设计

```
搜索栏 [排序图标▼] [分组图标▼]

排序下拉菜单:
- 按名称 ↑↓
- 按时间 ↑↓
- 按大小 ↑↓

分组下拉菜单:
- 无
- 按类型
- 按日期
- 按大小
```

### 3. 持久化 key 命名
遵循项目现有命名规范：
- `aurora_add_image_sort_by`
- `aurora_add_image_sort_direction`
- `aurora_add_image_group_by`

### 4. 实现细节

**排序逻辑：**
- 名称：localeCompare 中文支持
- 时间：new Date(a.updatedAt).getTime() 比较
- 大小：直接比较 meta.sizeKb

**分组逻辑：**
- 无：不分组，保持现有平面列表
- 按类型：按文件扩展名分组（jpg, png, 等）
- 按日期：按 updatedAt 的 YYYY-MM-DD 分组
- 按大小：按范围分组（<100KB, 100KB-1MB, 1-5MB, >5MB）

**UI 交互：**
- 点击排序图标显示下拉菜单
- 再次点击或点击外部关闭菜单
- 当前选中项高亮显示
- 图标按钮显示当前状态（如排序时显示方向箭头）