## 目标
实现参考模式下 TabBar 的智能显示/隐藏：默认隐藏，鼠标悬停在窗口顶部时显示

## 实现步骤

### 1. 修改 TabBar.tsx
- 新增 props: `isReferenceMode` (是否处于参考模式)
- 新增 state: `isHoveringTabBar` (鼠标是否在 TabBar 上)
- 添加鼠标事件监听：检测鼠标是否在顶部 10px 区域或 TabBar 本身
- 使用 CSS transform/opacity 实现平滑的显示/隐藏动画
- 鼠标离开 TabBar 后延迟 300ms 隐藏，避免闪烁

### 2. 修改 App.tsx
- 将 `hideTabBar` 状态改为 `isReferenceMode` 传递给 TabBar
- 不再条件渲染 TabBar，而是始终渲染但传递参考模式状态

### 3. 修改 ImageComparer.tsx (可选优化)
- 移除 `onReferenceModeChange` 的延迟调用，直接同步通知父组件

## 技术细节

**TabBar 显示/隐藏动画：**
```tsx
// 参考模式下，TabBar 默认向上平移隐藏
transform: isReferenceMode && !isHoveringTabBar ? 'translateY(-100%)' : 'translateY(0)'
opacity: isReferenceMode && !isHoveringTabBar ? 0 : 1
transition: all 200ms ease-out
```

**悬停检测区域：**
- 在 TabBar 上方添加一个 10px 高的透明检测条
- 鼠标进入检测条或 TabBar 本身时，显示 TabBar
- 鼠标离开两者后，延迟隐藏

**文件修改列表：**
1. `src/components/TabBar.tsx` - 添加悬停检测和动画
2. `src/App.tsx` - 修改 TabBar 渲染逻辑

这个方案可以优雅地解决闪烁问题，同时提供更好的用户体验。