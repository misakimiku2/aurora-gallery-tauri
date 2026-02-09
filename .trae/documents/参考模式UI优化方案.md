## 目标

优化参考模式下的UI显示，解决右键菜单无法完整显示的问题，并改进小窗口下的界面布局。

## 任务列表

### 1. 右键菜单自适应优化 ([ComparerContextMenu.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/comparer/ComparerContextMenu.tsx))

* 检测窗口大小，当高度小于350px时切换为紧凑模式

* 紧凑模式下：减小内边距、字体大小、图标尺寸

* 添加菜单项分组/折叠功能，将次要操作收纳到"更多"子菜单

* 确保菜单在200x200窗口下也能完整显示

### 2. 隐藏底部操作提示 ([ImageComparer.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/ImageComparer.tsx#L2094-L2114))

* 当 `isReferenceMode` 为 true 时，隐藏底部的快捷键提示栏

* 位置：第2094-2114行的 Shortcuts Hint div

### 3. TabBar 响应式优化 ([TabBar.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TabBar.tsx))

* 监听窗口宽度变化

* 当窗口宽度小于260px时：

  * 隐藏标签页标题（只保留图标）

  * 隐藏除了关闭按钮外的所有控制按钮

  * 保持关闭按钮可见以便退出

* 参考模式下鼠标悬停时，只显示关闭按钮和当前标签页

### 4. 窗口临时扩大 + 菜单位置智能调整 ([ImageComparer.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/ImageComparer.tsx#L967-L1000))

当检测到窗口太小（高度<350px）时：

**步骤1：计算需要的窗口扩展**
- 计算菜单所需最小高度（根据菜单项数量）
- 计算需要扩展的窗口高度

**步骤2：调整窗口大小和位置**
- 扩大窗口高度（保持宽度不变）
- 如果窗口在屏幕底部，向上扩展；如果在顶部，向下扩展
- 使用 `window.setSize()` 和 `window.setPosition()`

**步骤3：调整菜单位置**
- 关键：将菜单的 `y` 坐标调整为新窗口的**中心区域**
- 而不是使用原始的鼠标 `e.clientY` 位置
- 计算偏移量：`newMenuY = originalMouseY + windowHeightDelta / 2`
- 确保菜单完全在新窗口可视区域内

**步骤4：恢复窗口**
- 菜单关闭后，延迟300ms恢复原始窗口大小和位置

### 菜单位置调整示例

```
原始状态（200x200）：
┌────────────┐
│            │
│   鼠标位置  │ ← 菜单从这里呼出会被裁剪
│     ✕      │
└────────────┘

扩大后（200x400）：
┌────────────┐
│            │
│   菜单显示  │ ← 菜单调整到中心区域
│   ┌────┐   │
│   │选项│   │
│   └────┘   │
│            │
│   鼠标位置  │ ← 原鼠标位置（相对新窗口偏下）
│     ✕      │
└────────────┘
```

## 预期效果

* 200x200的参考模式下，右键菜单可以完整显示

* 底部操作提示在参考模式下自动隐藏

* 窗口宽度小于260px时，TabBar只显示关闭按钮

* 菜单呼出位置智能调整，避免被裁剪

