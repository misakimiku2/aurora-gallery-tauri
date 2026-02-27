# 智能创建人物模态框 UI 调整计划

## 问题分析

### 1. 头像裁剪后变成缩略图
- **位置**: 第 489 行
- **原因**: `coverSrc` 优先使用 `thumbnailUrls[coverFileId]`（缩略图）
- **问题**: 裁剪完成后，头像显示的是缩略图而非裁剪后的原图效果
- **解决方案**: 裁剪后的头像预览应该使用原图 `coverOriginalSrc`

### 2. 人物列表高度固定
- **位置**: 第 720 行 `h-48` 和第 33 行 `LIST_HEIGHT = 200`
- **问题**: 角色列表高度固定为 192px (h-48)，不能随窗口自适应
- **解决方案**: 使用 `flex-1` 让列表自动填充剩余空间，移除固定高度

### 3. 相似度阈值滑块位置调整
- **当前位置**: 左侧面板（第 755-768 行）
- **需求**: 
  - 将现有滑块移动到右侧图片预览区域
  - 在原位置新增"角色列表检测阈值"滑块
  - 两个滑块功能独立

---

## 实施步骤

### 步骤 1: 修复头像裁剪后显示缩略图问题
1. 修改 `coverSrc` 的计算逻辑
2. 当有 `coverFaceBox`（已裁剪）时，使用原图 `coverOriginalSrc`
3. 否则使用缩略图

```tsx
// 修改前
const coverSrc = coverFile && coverFileId 
  ? thumbnailUrls[coverFileId] || (coverFile.path ? convertFileSrc(coverFile.path) : null) 
  : null;

// 修改后
const coverSrc = coverFile && coverFileId 
  ? (coverFaceBox 
      ? (coverFile.path ? convertFileSrc(coverFile.path) : null)  // 裁剪后用原图
      : thumbnailUrls[coverFileId] || (coverFile.path ? convertFileSrc(coverFile.path) : null))
  : null;
```

### 步骤 2: 人物列表高度自适应
1. 移除 `LIST_HEIGHT` 常量
2. 将 `h-48` 改为 `flex-1 min-h-0`
3. 使用 `react-window` 的 `parentRef` 实现动态高度，或改用普通滚动

### 步骤 3: 新增角色列表检测阈值滑块
1. 新增 `characterThreshold` 状态（默认 0.1）
2. 新增 `characterDebounceTimerRef` 用于防抖
3. 修改 `loadCharacters` 的 useEffect 依赖 `characterThreshold`
4. 在左侧面板添加新滑块

### 步骤 4: 移动相似度阈值滑块到右侧
1. 从左侧面板移除现有滑块
2. 在右侧预览区域标题栏下方添加滑块

---

## 修改文件

- `src/components/modals/SmartCreatePersonModal.tsx`

---

## 详细代码变更

### 1. 新增状态和 ref

```tsx
const [characterThreshold, setCharacterThreshold] = useState(0.1);
const characterDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);
```

### 2. 修改 loadCharacters useEffect

```tsx
useEffect(() => {
  const loadCharacters = async () => {
    // ... 使用 characterThreshold
  };
  loadCharacters();
}, [clipSettings.enabled, clipSettings.modelName, characterThreshold, language]);
```

### 3. 角色列表检测阈值滑块处理函数

```tsx
const handleCharacterThresholdChange = useCallback((newThreshold: number) => {
  setCharacterThreshold(newThreshold);
  
  if (characterDebounceTimerRef.current) {
    clearTimeout(characterDebounceTimerRef.current);
  }
  
  characterDebounceTimerRef.current = setTimeout(async () => {
    // 重新加载角色列表
  }, 200);
}, [clipSettings, language]);
```

### 4. 布局调整

左侧面板：
- 角色列表区域改为 `flex-1 min-h-0`
- 新增角色列表检测阈值滑块

右侧面板：
- 标题栏下方新增相似度阈值滑块
