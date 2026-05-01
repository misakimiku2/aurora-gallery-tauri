# 安卓端后台任务弹窗UI优化记录

## 概述

本次修改针对安卓端后台任务弹窗（TaskProgressModal）及其最小化后显示在左侧面板底部的任务卡片（TreeSidebar）进行了UI优化，使安卓端的交互体验更符合触屏操作习惯。

---

## 一、后台任务弹窗（TaskProgressModal）放大适配

**文件**: `src/components/TaskProgressModal.tsx`

### 修改内容

通过 `isAndroidPlatformCached()` 检测安卓平台，条件性地应用更大的样式尺寸：

| 元素 | 桌面端 | 安卓端 |
|------|--------|--------|
| 弹窗宽度 | `w-96` (384px) | `w-[28rem]` (448px) |
| 标题字体 | `text-sm` (14px) | `text-base` (16px) |
| 正文/进度文字 | `text-xs` (12px) | `text-sm` (14px) |
| 缩小按钮图标 | `Minus size={14}` | `Minus size={18}` |
| 暂停/恢复按钮图标 | `Pause/Loader2 size={12}` | `Pause/Loader2 size={16}` |
| 按钮内边距 | `p-1` | `p-2` |
| 进度条高度 | `h-1.5` (6px) | `h-3` (12px) |
| 内容区内边距 | `p-4` | `p-5` |

### 实现方式

在组件内部定义平台相关变量：

```tsx
const isAndroid = isAndroidPlatformCached();
const iconSize = isAndroid ? 18 : 14;
const smallIconSize = isAndroid ? 16 : 12;
const btnPad = isAndroid ? 'p-2' : 'p-1';
const titleClass = isAndroid ? 'font-bold text-base' : 'font-bold text-sm';
const textClass = isAndroid ? 'text-sm' : 'text-xs';
const progressH = isAndroid ? 'h-3' : 'h-1.5';
const modalW = isAndroid ? 'w-[28rem]' : 'w-96';
```

---

## 二、最小化任务卡片（TreeSidebar）UI重构

**文件**: `src/components/TreeSidebar.tsx`

### 修改内容

#### 2.1 字体放大

| 元素 | 桌面端 | 安卓端 |
|------|--------|--------|
| "后台任务"标题 | `text-[10px]` | `text-xs` (12px) |
| 任务标题 | `text-xs` (12px) | `text-sm` (14px) |

#### 2.2 卡片布局重构

- 卡片高度固定为 `h-[53px]`
- 移除了安卓端的独立进度条
- 整个卡片变成进度条样式：从左往右按百分比填充颜色
- 百分比文字独立于标题显示，使用 `shrink-0` 防止被截断

显示效果：**正在处理主色调 45%**

#### 2.3 进度条卡片样式

安卓端卡片使用三层结构：

| 层级 | 说明 |
|------|------|
| 底层 | `absolute` 定位的纯色进度填充，宽度 = `percent%` |
| 波浪层 | `absolute` 定位的半透明渐变条，配合波浪动画从左往右扫过 |
| 内容层 | `relative z-10` 的文字和按钮，始终可见 |

颜色规则：
- 任务进行中：蓝色 (`bg-blue-500`)
- 任务暂停：黄色 (`bg-yellow-500`)

#### 2.4 按钮放大与常驻显示

| 元素 | 桌面端 | 安卓端 |
|------|--------|--------|
| 暂停/继续按钮图标 | `size={10}`, `p-1` | `size={16}`, `p-1.5` |
| 恢复弹窗按钮图标 | `size={10}`, `p-1` | `size={16}`, `p-1.5` |
| 恢复弹窗按钮可见性 | hover时显示 | 常驻显示 |

---

## 三、波浪动画

**文件**: `index.css`

### 新增动画

```css
@keyframes progress-wave {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(200%);
  }
}

.animate-progress-wave {
  animation: progress-wave 2.5s infinite ease-in-out;
}
```

### 实现原理

波浪层是一个宽度为卡片 1/3 的半透明渐变条：

```tsx
<div
  className="absolute inset-y-0 left-0 w-1/3 animate-progress-wave"
  style={{
    background: `linear-gradient(90deg, transparent 0%, ${progressColorMid} 50%, transparent 100%)`,
  }}
/>
```

- 元素从卡片左侧外部 (`translateX(-100%)`) 开始
- 通过 `translateX` 平移到卡片右侧外部 (`translateX(200%)`)
- 使用 `ease-in-out` 缓动函数，产生波浪扫过的视觉效果
- 颜色随任务状态变化：运行时半透明蓝色，暂停时半透明黄色

---

## 四、翻译文字调整

**文件**: `src/utils/translations.ts`

将 `processingColors` 从 "正在处理图片主色调" 缩短为 "正在处理主色调"，以适配安卓端卡片宽度限制。

---

## 修改文件清单

| 文件 | 修改类型 |
|------|----------|
| `src/components/TaskProgressModal.tsx` | 安卓端弹窗UI放大适配 |
| `src/components/TreeSidebar.tsx` | 最小化任务卡片重构为进度条样式 |
| `index.css` | 新增波浪动画 `progress-wave` |
| `src/utils/translations.ts` | 缩短翻译文字 |
