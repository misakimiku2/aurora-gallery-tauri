## 问题分析
颜色选择器在拖动时出现圆环回弹现象，这是由于 React 状态更新和闭包问题导致的：

1. `updateSV` 和 `updateHue` 的 `useCallback` 依赖了 `hsv`，导致每次 `hsv` 变化都会重新创建函数
2. `handleHsvChange` 使用了旧的 `hsv` 闭包值，造成状态更新不一致

## 修复方案

### 1. 重构 handleHsvChange
使用函数式状态更新，确保始终使用最新的状态值：
```typescript
const handleHsvChange = (newHsv: Partial<HSV>) => {
  setHsv(prev => {
    const updatedHsv = { ...prev, ...newHsv };
    const rgb = hsvToRgb(updatedHsv);
    const newHex = rgbToHex(rgb);
    setHex(newHex);
    onChange(newHex);
    return updatedHsv;
  });
};
```

### 2. 移除 updateSV 和 updateHue 的不必要依赖
将 `updateSV` 和 `updateHue` 改为普通函数或使用空依赖的 useCallback，因为它们只依赖 DOM 和 handleHsvChange：
```typescript
const updateSV = useCallback((clientX: number, clientY: number) => {
  // 只读取 DOM，不依赖 hsv
}, []); // 空依赖

const updateHue = useCallback((clientX: number) => {
  // 只读取 DOM，不依赖 hsv
}, []); // 空依赖
```

### 3. 使用 ref 保存 onChange 回调
避免 onChange 变化导致的问题：
```typescript
const onChangeRef = useRef(onChange);
onChangeRef.current = onChange;
```

## 修改文件
- `c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src\components\ColorPickerPopover.tsx`

## 预期效果
- 拖动颜色选择器时圆环跟随鼠标平滑移动，无回弹
- 颜色值实时更新
- 性能优化，减少不必要的函数重建