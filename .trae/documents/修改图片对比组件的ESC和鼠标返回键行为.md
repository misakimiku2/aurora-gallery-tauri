## 修改目标
当图片对比组件处于打开"添加图片"窗口或参考模式时，按下ESC或鼠标侧边返回键时，优先关闭弹窗/退出参考模式，而不是关闭整个标签页。

## 具体修改

### 1. ImageComparer.tsx

修改键盘事件处理（第1766-1781行）：
```typescript
// Keyboard support
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // 优先级1: 如果添加图片窗口打开，关闭它
      if (isAddImageModalOpen) {
        setIsAddImageModalOpen(false);
        return;
      }
      // 优先级2: 如果处于参考模式，退出参考模式
      if (isReferenceMode) {
        toggleReferenceMode();
        return;
      }
      // 优先级3: 关闭标签页
      if (onCloseTab) onCloseTab();
      else onClose();
    }
    if (e.key === 'a' || e.key === 'A') {
      setIsSnappingEnabled(prev => !prev);
    }
    if (e.key === 'r' || e.key === 'R') {
      toggleReferenceMode();
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [onClose, onCloseTab, toggleReferenceMode, isAddImageModalOpen, isReferenceMode]);
```

修改鼠标侧边按钮事件处理（第1783-1799行）：
```typescript
// Handle mouse side buttons
useEffect(() => {
  const handleMouseUp = (e: MouseEvent) => {
    if (e.button === 3) {
      e.stopImmediatePropagation();
      e.preventDefault();
      // 优先级1: 如果添加图片窗口打开，关闭它
      if (isAddImageModalOpen) {
        setIsAddImageModalOpen(false);
        return;
      }
      // 优先级2: 如果处于参考模式，退出参考模式
      if (isReferenceMode) {
        toggleReferenceMode();
        return;
      }
      // 优先级3: 关闭标签页
      if (onCloseTab) onCloseTab();
      else onClose();
    } else if (e.button === 4) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  window.addEventListener('mouseup', handleMouseUp, { capture: true });
  return () => window.removeEventListener('mouseup', handleMouseUp, { capture: true });
}, [onClose, onCloseTab, toggleReferenceMode, isAddImageModalOpen, isReferenceMode]);
```

### 2. AddImageModal.tsx

添加键盘ESC事件支持（在组件内添加useEffect）：
```typescript
// 添加ESC键关闭支持
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [onClose]);
```

这个修改应该添加在现有的其他useEffect之后，大约第649行左右。

## 依赖更新
- `ImageComparer.tsx` 中的两个useEffect依赖数组需要更新，添加 `isAddImageModalOpen` 和 `isReferenceMode`