# 人物界面排序与分组功能

## 功能概述

为人物视图（People Overview）新增了排序与分组功能，用户可以根据不同维度对人物进行排序和分组显示。

## 功能详情

### 1. 排序功能

**排序选项：**
- **名称** (`name`): 按人物名称字母/拼音顺序排序
- **文件数量** (`count`): 按人物关联的文件数量排序
- **创建日期** (`created`): 按人物封面文件的创建时间排序

**排序方向：**
- 升序 (`asc`)
- 降序 (`desc`)

### 2. 分组功能

**分组选项：**
- **无分组** (`none`): 平铺显示所有人物
- **按名称首字母** (`name`): 按 A-Z、0-9、# 分组
- **按专题** (`topic`): 按人物所属的专题分组

### 3. 设置持久化

所有排序和分组设置会自动保存到 `localStorage`，下次打开应用时会恢复上次的设置。

**存储的键值：**
- `aurora_person_sort_by`: 排序方式
- `aurora_person_sort_direction`: 排序方向
- `aurora_person_group_by`: 分组方式

## 文件改动

### 1. 类型定义 ([src/types.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/types.ts))

新增人物视图专用的排序和分组类型：

```typescript
export type PersonSortOption = 'name' | 'count' | 'created';
export type PersonGroupByOption = 'none' | 'name' | 'topic';
```

### 2. PersonGrid 组件 ([src/components/PersonGrid.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/PersonGrid.tsx))

- 实现排序逻辑，支持名称、文件数、创建日期三种排序方式
- 实现分组逻辑，支持按名称首字母和专题分组
- 使用 `getPinyinGroup` 函数正确处理中文名称的首字母分组
- 分组头部支持折叠/展开功能
- 布局计算适配缩略图大小变化

### 3. TopBar 组件 ([src/components/TopBar.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx))

- 在人物视图下显示专用的排序/分组按钮（Users 图标）
- 添加人物视图专用的排序/分组菜单
- 支持切换排序方向和分组方式

### 4. App.tsx ([src/App.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx))

- 添加人物排序和分组的状态管理
- 实现设置持久化，使用 `localStorage` 保存用户选择
- 初始化时从 `localStorage` 读取保存的设置

### 5. FileGrid 组件 ([src/components/FileGrid.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FileGrid.tsx))

- 添加 `personSortBy`、`personSortDirection`、`personGroupBy` props
- 将排序和分组参数传递给 PersonGrid 组件

### 6. 翻译文件 ([src/utils/translations.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/translations.ts))

新增翻译键：
- `person.sortBy`: 人物排序
- `person.fileCount`: 按文件数
- `person.groupByName`: 按名称首字母
- `person.groupByTopic`: 按专题

## 使用说明

1. **打开人物视图**：点击侧边栏的"人物"选项
2. **访问排序/分组菜单**：点击工具栏上的 Users 图标按钮
3. **选择排序方式**：在菜单中选择"名称"、"文件数"或"创建日期"
4. **切换排序方向**：点击"升序"或"降序"选项
5. **选择分组方式**：在"分组方式"部分选择"无"、"按名称首字母"或"按专题"
6. **折叠/展开分组**：点击分组头部可以折叠或展开该分组

## 技术实现

### 中文首字母分组

使用项目中已有的 `getPinyinGroup` 函数（位于 `src/utils/textUtils.ts`），该函数使用 `Intl.Collator` 进行准确的拼音分组。

### 布局计算

- 无分组时：使用 `useLayout` hook 计算整体布局
- 分组时：每个分组单独计算布局，根据 `thumbnailSize` 动态计算列数和项目尺寸

### 虚拟化

- 无分组时：支持虚拟滚动，只渲染可视区域内的人物
- 分组时：每个分组独立渲染，暂不支持跨分组的虚拟化

## 注意事项

1. 按创建日期排序时，使用人物封面文件的创建时间作为排序依据
2. 按专题分组时，如果人物属于多个专题，会被放入第一个匹配的专题
3. 未分类的人物会显示在"未分类"分组中
4. 设置会自动保存，刷新页面后会恢复上次的排序和分组设置
