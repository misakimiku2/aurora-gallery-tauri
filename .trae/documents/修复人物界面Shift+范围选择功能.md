## 问题原因

在 `App.tsx` 的 `handlePersonClick` 函数中，范围选择逻辑使用的排序方式是固定的 `count` 降序：

```typescript
allPeople.sort((a, b) => b.count - a.count);
```

但 `PersonGrid` 组件中人物的排序是根据 `sortBy` 和 `sortDirection` props 动态变化的（名称、文件数、创建日期，升序或降序）。

这导致 UI 显示顺序和范围选择逻辑的顺序不一致，从而选择错误的人物。

## 修复方案

修改 `App.tsx` 中的 `handlePersonClick` 函数（约第 1848-1850 行），使其使用与 `PersonGrid` 相同的排序逻辑：

1. 根据 `personSortBy` 状态值（'name' | 'count' | 'created'）选择排序字段
2. 根据 `personSortDirection` 状态值（'asc' | 'desc'）决定排序方向
3. 对于 'created' 排序，需要访问 `files` 获取封面文件的创建时间

这样确保范围选择时的顺序与 UI 显示顺序完全一致。