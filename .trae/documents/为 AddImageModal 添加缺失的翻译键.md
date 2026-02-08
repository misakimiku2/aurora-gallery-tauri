根据代码分析，需要为 `AddImageModal.tsx` 添加以下缺失的翻译键到 `translations.ts` 文件中：

**需要新增的 comparer 命名空间翻译（中文和英文）：**

```
comparer: {
  addImages: '添加图片到画布' / 'Add Images to Canvas',
  selectAll: '全选' / 'Select All',
  clearSelection: '清除' / 'Clear',
  selectNode: '请选择左侧项目查看图片' / 'Please select an item from the left to view images',
  noImages: '暂无图片' / 'No images',
  selectedCount: '已选择' / 'Selected',
  images: '张图片' / 'images',
  totalResults: '共找到' / 'Total results',
  totalCount: '总计' / 'Total',
  limitReached: '已达到上限' / 'Limit reached',
  canvasCount: '画布中' / 'In canvas',
  confirmAdd: '确认添加' / 'Confirm Add'
}
```

**需要新增的 pagination 命名空间翻译（中文和英文）：**

```
pagination: {
  prev: '上一页' / 'Previous',
  page: '第' / 'Page',
  pageOf: '页' / 'of',
  next: '下一页' / 'Next',
  perPage: '每页' / 'per page',
  items: '条' / 'items'
}
```

**需要新增的 search.placeholder 翻译：**

* 中文：'搜索文件名，按Enter执行...'

* 英文：'Search filename, press Enter...'

修改步骤：

1. 在 `translations.ts` 的 zh 对象中添加 comparer 和 pagination 命名空间
2. 在 translations.ts 的 en 对象中添加对应的英文翻译
3. 更新 search.placeholder 的翻译值

