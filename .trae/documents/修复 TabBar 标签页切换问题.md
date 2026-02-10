## 问题原因
在 `TabBar.tsx` 中，`handleDragStart` 函数用于在 Tauri 环境下拖动窗口。它通过检查 `data-no-drag` 属性、`.no-drag` 类名或 `button` 元素来避免在可交互元素上触发拖动。

但是，标签页元素只设置了 `style={{ WebkitAppRegion: 'no-drag' }}`，没有设置上述任何一个标记，导致点击标签页时也会触发 `window.startDragging()`，这会干扰 `onClick` 事件的正常触发。

## 修复方案
给标签页元素添加 `data-no-drag` 属性，让 `handleDragStart` 正确识别并跳过这些元素。

### 修改位置
[TabBar.tsx:L334-361](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx#L334-L361)

在标签页的 div 元素上添加 `data-no-drag` 属性：
```tsx
<div
  key={tab.id}
  onClick={() => onSwitchTab(tab.id)}
  data-no-drag  // 添加这一行
  ...
>
```

这样 `handleDragStart` 中的 `target.closest('[data-no-drag]')` 就能正确匹配到标签页，不会触发拖动，从而允许 `onClick` 事件正常触发。