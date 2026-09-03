# 文件夹图标 Canvas 合成性能优化 — 实现方案（v4 · 已落地）

> 目标：让 PC 端（Tauri / WebView2）的「经典 3D 文件夹」图标（`Folder3DIcon` `variant='classic'`）渲染成本与「单张图片」相同，彻底解决 2000+ 文件量级下的滚动卡顿；同时保证**图标视觉与悬停动画与当前 DOM 版 100% 一致**（含 3D 透视前板、扇形摊开悬停动画）。
>
> 状态：**已实现**。v4 = v3 实现说明 + 缩放/悬停/重启灰卡等 Bug 修复（§5 行 8~12）+ 诊断工具（§5.1），供后续会话继续调优时参考。
>
> 适用范围：Web 前端。`Folder3DIcon variant='classic'` 的 Canvas 替代实现，在「设置 → 文件夹图标样式」中作为**新增选项** **`canvas`** 提供，默认仍为 `classic`（DOM 版，不动），可随时切换对比与回退。安卓端 Kotlin 原生版与本方案无关。
>
> 适用范围：Web 前端。`Folder3DIcon variant='classic'` 的 Canvas 替代实现，在「设置 → 文件夹图标样式」中作为**新增选项** **`canvas`** 提供，默认仍为 `classic`（DOM 版，不动），可随时切换对比与回退。安卓端 Kotlin 原生版与本方案无关。

***

## 0. 版本演进

> 适用分支：`Mobil`。v1 基于旧快照，v2 按 `Mobil` 分支参数表重构，v3 已实现并落地。

| 项     | v1（旧快照草案）               | v2（Mobil 参数表重构）         | v3（已落地实现）                                                                                   |
| ----- | ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| 参数表   | 旧版 Folder3DIcon         | 当前 branch 逐项提取          | 保留 v2，修正 `CARD_FAN` 系数存储形式（见 §2.4）                                                          |
| 图标    | `mix-blend-overlay`     | `opacity-40` + 颜色 alpha | **实际用 lucide Path2D 同步手绘**（`stroke`），无 Image 异步依赖，shell 可同步合成                               |
| 数量角标  | `bg-black/20`+blur      | `bg-black/35`+`ring`    | 实际：`fillRect` 圆角 + `stroke` ring，`drawBadge` 单独导出，由组件在 staticBody 上即时补画（避免按 count 缓存爆炸）     |
| 3D 透视 | 手写投影                    | 手写投影 + 仿射近似             | **`projectPoint`** **逐点投影 +** **`affineAt`** **仿射**，与 DOM 无视觉差异                             |
| 位图分层  | shell / full 两级         | shell / full 两级         | **四层**：`back` / `front` / `shell` / `staticBody` + `full`（§3.3）                             |
| 调度    | 自建 idle 队列              | 复用 tiles 串行 idle 队列     | **心跳泵 + 滚动隔离 + 单任务超时强制跳过**（§3.5），解决队列冻结；`composeFull` 用 `back/front/shell` 合成，不再持有 shell 缓存 |
| 分辨率   | 1x                      | —                       | **合成位图与 canvas backing 均 ≥2x 像素密度**，显示时 GPU 降到 1x（§3.4），解决缩略图/角标发糊                          |
| 导出    | `transferToImageBitmap` | 保留                      | 保留；`composeShell/StaticBody/Full` 均输出 `ImageBitmap`，绝不 `toDataURL/toBlob`（`asset://` 污染）    |
| 悬停    | 第二张位图交叉淡化               | canvas 逐帧 JS 动画         | **rAF 逐帧复刻 300ms CSS ease**；预览图解码延迟到首次悬停（滚动中不解码）；解码完成仍在悬停则用真图重播（§3.7）                       |

***

## 1. 背景与目标

### 1.1 现状瓶颈（为什么卡）

当前 `Folder3DIcon` `classic` 变体每个文件夹图标由以下**高成本图层**叠加而成：

| 图层                                                               | 高成本原因                |
| ---------------------------------------------------------------- | -------------------- |
| 后板 SVG + `drop-shadow-sm`                                        | filter 产生独立合成层       |
| 3 张预览图（rotate/translate/scale + shadow-md + 2px 白边）              | 每张是独立变换层，悬停时 3 层同时重算 |
| 前板 SVG + `perspective(800px) rotateX(-10deg)` + `drop-shadow-lg` | 3D 透视强制每帧投影重算        |
| lucide 图标（`opacity-40`）                                          | 与前板叠加                |
| 数量角标（`bg-black/35` + ring）                                       | 少量额外层                |

单卡片 5\~7 个合成层，2000 个文件夹 → 上万个层，WebView2 合成器在滚动/悬停时必然卡顿。纯图片单卡只需 1 个位图层。

### 1.2 方案一句话

> **把每个文件夹图标的全部图层预先一次性合成到离屏位图里，运行时只贴一张位图。** 渲染成本 = 单张图片。**悬停动画**用 JS 逐帧复刻 DOM 的 CSS 变换（300ms `ease`），并且**动画帧与静止位图共用同一套** **`drawCard`/`drawBadge`** **实现**，保证静止 ↔ 动画首帧结构上必然一致。

### 1.3 关键事实：`asset://` 污染 canvas

- `getThumbnail` 返回 `convertFileSrc(path)` = `asset://` URL（`src/api/tauri-bridge/thumbnail.ts`）。

- 把 `asset://` 画入 canvas 后画布被污染：`toDataURL/toBlob/getImageData` 全部抛 SecurityError。

- **规则：合成与可见画布一律用** **`OffscreenCanvas.transferToImageBitmap()`** **导出，绝不调用任何读回 API。** `drawImage` 只传播污染标记、不抛错，本轮全程不读像素。

- 无 `OffscreenCanvas`/`transferToImageBitmap` 时 `isSpriteSupported()` 返回 false，自动回退 DOM 版。

***

## 2. 视觉参数表（100% 还原基准）

以下参数从 `Mobil` 分支 [Folder3DIcon.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/Folder3DIcon.tsx) 逐行提取，实际常量落在 [spriteComposer.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/spriteComposer.ts) 顶部。

### 2.1 整体布局（设计坐标空间 = 图标实际像素 S）

图标容器为正方形（外层 `aspect-square p-2`，以内容盒尺寸为 S）。百分比按 S 换算，固定像素值直接用真实 px。

| 元素        | 位置/尺寸（相对容器）                                                                             |
| --------- | --------------------------------------------------------------------------------------- |
| 后板 SVG    | 铺满正方形，viewBox `0 0 100 100`，`preserveAspectRatio="none"`                                |
| 预览图组容器    | `left:15% right:15% top:20% bottom:20%`（宽 0.70S、高 0.60S），`transform-origin: center`     |
| 前板        | 底部对齐、高 0.60S（y 0.40S→S），`transform-origin: bottom`，`perspective(800px) rotateX(-10deg)` |
| lucide 图标 | 前板内居中，size=32px，strokeWidth=1.5，`opacity-40`                                            |
| 数量角标      | 前板内 `bottom:8px right:12px`                                                             |

### 2.2 颜色（light/dark 分别合成）

| category   | 后板 light / dark       | 前板（light=dark） |
| ---------- | --------------------- | -------------- |
| `general`  | `#2563eb` / `#3b82f6` | `#60a5fa`      |
| `book`     | `#d97706` / `#f59e0b` | `#fbbf24`      |
| `sequence` | `#9333ea` / `#a855f7` | `#c084fc`      |

图标：`general→Folder`，`book→Book`，`sequence→Film`（lucide，Path2D 手绘，见 §4）。

### 2.3 后板（viewBox 0 0 100 100，Path2D 手动缩放绘制）

```
M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z
```

- 滤镜（仅 light，dark 无）：`drop-shadow(0 1px 1px rgb(0 0 0 / 0.05))`。

- 中间折角 `L45,30` 处：实际绘制时**不做圆角处理，与 DOM 直线一致**。

### 2.4 预览图（3 张，数组顺序 image\[2]/\[1]/\[0] = 后→前）

预览组容器 x∈\[15%,85%]，y∈\[20%,80%]。每张卡 = 白色圆角外框 `rounded-sm`(2px) + `border-[2px]` white + `shadow-md`（两层 drop-shadow）+ 内部 `object-cover` 裁图，占位为灰阶色块。

**堆叠态（cardBase，静止）**：

| 下标    | Tailwind 原文                                                 | 实际常量（tx/ty 为固定 px）                                 |
| ----- | ----------------------------------------------------------- | -------------------------------------------------- |
| 2（最底） | `rotate-6 translate-x-2 -translate-y-3 scale-90 opacity-80` | `rotate(6°) translate(8,-12) scale(0.9) alpha 0.8` |
| 1（中间） | `-rotate-3 -translate-x-1 -translate-y-1.5 scale-95`        | `rotate(-3°) translate(-4,-6) scale(0.95) alpha 1` |
| 0（最前） | `rotate-0 scale-100`                                        | 无变换，alpha 1                                        |

**悬停态（cardHover，扇形摊开，仅** **`images.length>=2`）**：

| 下标    | Tailwind 原文                                                     | 实际常量（tx/ty 为**相对卡片尺寸系数**，绘制时 × 卡宽/卡高）                        |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| 0（最前） | `rotate-[14deg] translate-x-[18%] translate-y-[-4%] scale-90`   | `rotate(14) tx 0.18 ty -0.04 scale 0.9`（换算 0.126S / -0.024S） |
| 1（中间） | `translate-y-[-10%] scale-100`                                  | `rotate(0) tx 0 ty -0.10 scale 1`                            |
| 2（最底） | `rotate-[-14deg] translate-x-[-18%] translate-y-[-4%] scale-90` | `rotate(-14) tx -0.18 ty -0.04 scale 0.9`                    |

**预览组容器悬停位移**（任意图片数量都生效）：`group-hover:-translate-y-3 group-hover:scale-105` = `translate(0,-12px) scale(1.05)` 绕容器中心。

> 注意：`cardBase.tx/ty` 是固定像素（8px 等）；`cardFan.tx/ty` 是相对卡片尺寸的系数。插值时两者要换算到同一单位（`drawHoverFrame` 中 `toTx = fan ? to.tx*cardW : from.tx`）。

**数量边界**：

- `0` 张：3 张灰阶占位卡（light `#9ca3af/#d1d5db/#ffffff` 后→中→前；dark `#4b5563/#374151/#6b7280`），悬停不扇形。

- `1` 张：仅前卡；`2` 张：前+中；`3` 张：全渲染。

**阴影**：`shadow-md` = `drop-shadow(0 4px 6px rgba(0,0,0,0.1)) drop-shadow(0 2px 4px rgba(0,0,0,0.1))`，canvas 用 `ctx.filter` 两层近似，绘制后 `ctx.filter='none'` 复位。

### 2.5 前板 + 3D 透视（viewBox 0 0 100 65，高 0.60S）

```
M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z
```

- 滤镜（仅 light）：`drop-shadow(0 10px 8px rgba(0,0,0,0.04)) drop-shadow(0 4px 3px rgba(0,0,0,0.1))`（= drop-shadow-lg 两层）。

- 变换：`perspective(800px) rotateX(-10deg)`，origin: bottom。

**canvas 复刻投影**（前板局部坐标 y∈\[0,0.60S]，底边中点 O=(S/2,0.60S)，结果平移 +0.40S）：

```
xr = x - S/2；yr = y - 0.60S
cos = cos(-10°) = 0.98481；sin = sin(-10°) = -0.17365
y' = yr·cos；z' = yr·sin；f = 800/(800 - z')
sx = S/2 + xr·f；sy = 0.60S + y'·f   （再 +0.40S 平移到图标坐标）
```

前板路径按 viewBox 采样（Q/C 曲线细分）逐点投影后填充（`projectPoint`）。

**图标与角标用仿射近似**（`affineAt(yc)`）：中心 yc 处 `f0 = f(yc)`，`scaleX=f0, scaleY=COS·f0`，原点 O，再平移到元素中心。图标中心取 `yc=0.30S`，角标中心 `yc = 角标局部 y + bh/2`。

### 2.6 图标（lucide，Path2D 同步手绘）

- 实际实现**不用 Image/`data:image/svg+xml`**，而是把 lucide path 数据常量 + `getPath2D` 缓存，`ctx.stroke` 直接绘制 —— 无异步依赖，shell 可**同步**合成（滚动兜底零等待）。

- 颜色叠加 `opacity-40`：light `#1e3a8a` alpha 0.28；dark `#ffffff` alpha 0.32。

- `strokeWidth=1.5`，`lineCap/lineJoin=round`。

### 2.7 数量角标

- 位置 `right:12px`、`bottom:8px`（前板局部）；`bg-black/35` 圆角全圆，`9px bold` 白字，padding 6/2，`ring-1 ring-white/15`（1px 描边）。无 backdrop-blur。

- 显示条件 `count !== undefined`（含 0）。

- `drawBadge` 独立导出 → 组件在 staticBody 绘制后**即时补画**，因此按 count 维度不需要缓存位图。

### 2.8 悬停动画参数

- `transition-transform duration-300`，`ease = cubic-bezier(0.25,0.1,0.25,1)`（数值二分求解 `easeCss`）。

- 变换组合同 CSS 语义：`T(center)·T(tx,ty)·R(a)·S(s)·T(-center)`，对 rotate/translate/scale/alpha **逐参数线性插值**（`p = easeCss(t/300)`）。

- 动画仅 rAF 期间逐帧绘制，t≥300ms 停止；mouseleave 反向播回。静止悬停零开销。

***

## 3. 架构设计（v3 实际落地）

### 3.1 运行时形态

```
<div ref=wrapRef class="relative w-full h-full select-none group"   // 悬停事件挂这里
  onMouseEnter/onMouseLeave>
  <canvas class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
</div>
```

- 可见层统一 **2d context**：静止贴 `full`/`staticBody` 位图；悬停逐帧绘制 `drawHoverFrame`。

- **`CANVAS_SCALE = 1.15`**：扇形展开 ±14° 的卡片角会超出图标边界——DOM 版无 overflow 裁剪，canvas 无法裁剪，故把 canvas 画布放大到 1.15× 居中（setTransform 平移缩放后视觉尺寸不变），留白容纳转角；`clearWhole` 需清整块（含留白），否则残留黑影。

- 合成位图与可见 canvas 都是 ≥2x 像素（§3.4），GPU 缩放到 1x CSS 显示。

### 3.2 模块划分（实际落地文件）

| 文件                                                                                                                       | 职责                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [spriteComposer.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/spriteComposer.ts)                | 纯函数合成引擎：常量/Path2D/3D 投影/`composeBack`/`composeFront`/`composeShell`/`composeStaticBody`/`composeFull`/`drawCard`/`drawBadge`/`drawHoverFrame`/`loadImage(s)`（5s 超时兜底）/`easeCss`/`isSpriteSupported`       |
| [spriteCache.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/spriteCache.ts)                      | `layerCache`（back/front/shell/staticBody 同步缓存）+ `fullCache`（有界 LRU 96）+ 串行 idle 调度（心跳泵）；导出 `getBack/getFront/getShell/getStaticBody/getFull`、`spriteStats` 统计                                             |
| [Folder3DIconCanvas.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/Folder3DIconCanvas.tsx) | 可见组件：ResizeObserver 尺寸 + MutationObserver 主题 + canvas backing 2x + 静止态绘制 + full 异步升级 + rAF 悬停动画（真图延迟解码/重播）                                                                                                |
| [FolderThumbnail.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FolderThumbnail.tsx)       | 接入点：`folderIconStyle==='canvas' && isSpriteSupportedSafe()` → `Folder3DIconCanvas`，否则 DOM 版                                                                                                               |
| [GeneralPanel.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/settings/GeneralPanel.tsx)    | 设置项：新增 `canvas` 选项（预览图直接渲染 `Folder3DIconCanvas`），`types.ts` 中 `folderIconStyle` 增加 `'canvas'`，[translations.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/translations.ts) 加中英文案 |

由 [scrollProfiler.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/scrollProfiler.ts) 输出 Sprite 合成统计行（合成/命中/失败/取消/队列/缓存/渲染分辨率），用于量化对比。

### 3.3 位图分层与缓存设计

实际采用**四层位图**（比 v2 的 shell/full 两级更细）：

| 层            | 内容                          | 合成时机        | 缓存                                                                 | <br /> |
| ------------ | --------------------------- | ----------- | ------------------------------------------------------------------ | ------ |
| `back`       | 后板（含 light 阴影）              | 同步          | `layerCache`：`(back, category, theme, size, res)`                  | <br /> |
| `front`      | 前板(3D 投影) + 图标              | 同步          | `layerCache`：`(front, category, theme, size, res)`                 | <br /> |
| `shell`      | back + front（无预览无角标）        | 同步          | `layerCache`：\`(shell                                              | …)\`   |
| `staticBody` | back + 三张灰阶占位卡 + front（无角标） | 同步          | `layerCache`：`(static, category, theme, size, res)`                | <br /> |
| `full`       | back + 三张真实预览卡 + front + 角标 | 异步（idle 队列） | `fullCache` LRU：`(folderId, theme, size, res, count, previewSrcs)` | <br /> |

- 数量少的高频层（back/front/shell/staticBody）按 `(category×theme×size×res)` 全局共享，所有文件夹复用；`full` 按 folderId 有界 **LRU 96 条**（2x 位图约 380KB/张，上限 \~40MB）。

- `composeFull` 内部直接合成，**不再持有 shell 位图引用**（v2 曾计划复用 shell，实测对位图生命周期管理不利）；`composeBack/Front` 每次都合成各自的小位图，供 full 与逐帧悬停 `drawHoverFrame` 共同使用。

- 角标不进位图缓存：`composeStaticBody` / `composeFull` 由组件/引擎分别调用 `drawBadge` 补画 → 避免按 count 维度缓存爆炸。

### 3.4 渲染分辨率策略（解决「缩略图/角标发糊」）

- **根源**：canvas 默认 `imageSmoothingQuality='low'`（双线性），把缩略图放大插值时明显发糊；DOM `<img>` 是高质量重采样。

- **修复**（`renderRes()`，spriteCache）+ `applySmoothing()`（composer）：

  - 合成位图统一用 `res = max(2, devicePixelRatio)` 像素密度；

  - 可见 canvas backing 也用同一 `res`（`setTransform(res,0,0,res,pad*res,pad*res)`，pad 为 CANVAS\_SCALE 留白）；

  - 显示时浏览器 GPU 按 CSS 尺寸缩小到 1x —— 与 DOM 版「源图纹理超采样」同策略，边缘/文字/缩略图全部锐利；

  - `imageSmoothingEnabled=true; imageSmoothingQuality='high'`（try/catch 兜旧实现）。

### 3.5 合成调度（心跳泵 + 滚动隔离）

核心原则：**合成绝不与滚动赛跑**。在 [spriteCache.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/spriteCache.ts) 实现：

1. **滚动隔离**：`getGlobalScrollState() !== 'idle'` 时一律不启动新合成（只入队），滚动是最高优先级；`subscribeScrollState` 收到 idle 且队非空时立即续泵。
2. **串行 + macrotask 让出**：同一时刻只跑一个 `composeFull`（`current` 互斥）；每张完成后 `setTimeout(pump, 0)` 下一 macrotask 续泵，浏览器可插帧渲染。
3. **心跳兜底**：`setInterval(HEARTBEAT_MS=300)`：队列非空且无任务在跑且静止 → 泵；当前任务超过 `TASK_TIMEOUT_MS=6000` → **强制跳过**（`null` 计数），避免图片 promise 永不 settle 卡死队列（与 `loadImage` 5s 兜底配合）。
4. **同 key 去重**：`runTask` 开头查 `fullCache`，命中直接 resolve（`hit++`）。
5. **Abort 取消**：`FullParams.signal` 由组件卸载时 abort，组件在 `getFull().then` 里检测 `cancelled`（`cancel++`）丢弃。

> 演进：v2 曾计划「复用 folderTilesRenderer 串行 idle 队列」。落地时发现滚动状态未复位时链会断裂导致冻结 → 升级为心跳泵（v3），队列任何情况下最终必然排空。

### 3.6 CORS / Canvas 污染

- 规则：**合成与可见画布从不读回像素**（无 toDataURL/toBlob/getImageData）；导出一律 `OffscreenCanvas.transferToImageBitmap()`。

- 无 OffscreenCanvas/transferToImageBitmap → `isSpriteSupported()` false → 回退 DOM 版。

### 3.7 悬停动画细节（Folder3DIconCanvas）

- 静止：立即画 `staticBody` + `drawBadge`（同步、不依赖队列）→ 滚动/换档后新卡即时显示完整图标；`getFull` 异步升级真图覆盖。

- 首次 `mouseenter` 才 `loadImages` 解码预览图（**滚动中卡片进出视口不解码**，避免抢占主线程）。**v4 起修正**：有图源但未解码时**不再先用空 imgs 起动画**（否则"先闪白卡再换真图"）——保持当前静止位图，解码完成若仍在悬停（`hoveringRef`）再从静止态用真图起动画；仅当确实无图源（0 张）时才用灰卡占位起动画（与 DOM 版一致）。

- `animate(dir)` 驱动 rAF：`t` 按帧累计（±dt），`progressRef` 记录进度供离开时反向续播；结束后取消 rAF。依赖项不含 `imgs`，动画从 `imgsRef` 读最新结果。

- **离开动画结束必须恢复静止位图**（`paintStaticState`：贴 `lastFullRef` + 叠当前尺寸 front 覆盖 + 重画固定 px 角标，或回退 staticBody）——若动画期间用的始终是占位卡 imgs，最后一帧会停在白卡上且无人再画回去。imgs 未就绪时 `mouseleave` 不播反向动画（进入侧本就没起动画）。

***

## 4. 实现状态（文件 × 要点）

已全部实现并通过编译。关键代码位置：

- 合成引擎：[spriteComposer.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/spriteComposer.ts)（约 600 行）——
  `pathToPoints`（SVG path 解析采样，Q/C 细分）、`projectPoint`/`affineAt`（3D 透视）、`drawBackPlate`/`drawFrontPlate`（Path2D + light 阴影）、`drawIcon`（lucide Path2D stroke）、`drawBadge`、`drawCard`（白框+clip+object-cover+shadow-md）、`composeBack/Front/Shell/StaticBody/Full`、`drawHoverFrame`（clearWhole + 容器 hover + 三卡插值 + front + 角标）、`loadImage`（5s 超时）、`easeCss`。

- 缓存调度：[spriteCache.ts](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/spriteCache.ts)（约 280 行）——见 §3.3/§3.4/§3.5。

- 组件：[Folder3DIconCanvas.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/Folder3DIconCanvas.tsx)（约 230 行）——见 §3.7。

- 接入：[FolderThumbnail.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/FolderThumbnail.tsx#L321-L335) 按 `folderIconStyle === 'canvas' && isSpriteSupportedSafe()` 分支。

- 设置：[GeneralPanel.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/settings/GeneralPanel.tsx) 三选项 classic / tiles / canvas（canvas 预览直接渲染 `Folder3DIconCanvas`）。

***

## 5. Bug 修复清单（本次会话逐项修复）

| # | 现象                                                                          | 根因                                                       | 修复                                                                                                    |
| - | --------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1 | 静止时只有外壳（无预览卡/角标），且滚动/换档后缩略图消失                                               | 静止态只画了 shell；`full` 依赖 idle 队列异步合成，且位图就绪前组件卸载导致 `cancel` | 新增 `composeStaticBody` 同步合成「灰卡占位态」，组件立即绘制并即时补画 `drawBadge`；`getFull` 到达后整幅覆盖（两态图层顺序一致，无缝）             |
| 2 | 预览卡被前板遮挡（出现在图标上方）                                                           | 合成顺序错误（先画前板再画预览卡）                                        | 修正绘制顺序：**back → 预览卡 → front → 角标**（与 DOM z-10\<z-20 一致，前板自然遮挡卡片下半部分）；`drawHoverFrame` 同序              |
| 3 | 悬停出现黑影/拖影                                                                   | 画布放大 1.15× 后，每帧卡片位置不同，残留                                 | `clearWhole` 先 `setTransform(1,0,0,1,0,0)` 清整块 backing（含留白区）再复位                                       |
| 4 | 缩略图明显发糊、角标略糊                                                                | canvas 默认双线性（low quality）且 1x 光栅                         | 双端超采样：合成位图 `res = max(2, dpr)`、canvas backing 同 res、`imageSmoothingQuality='high'`、GPU 降到 1x 显示（§3.4） |
| 5 | 合成队列冻结（full 永不执行）                                                           | 图片 promise 不 settle → `current` 永不为空 → 后续任务卡死            | `loadImage` 5s 超时兜底 + 心跳 300ms 检测 `TASK_TIMEOUT_MS=6000` 强制跳过 + 链断裂自动续泵（§3.5）                         |
| 6 | 悬停卡片插值单位混乱                                                                  | cardFan 的 tx/ty 是相对系数、cardBase 是固定 px                    | `drawHoverFrame` 插值时统一换算：`toTx = fan ? to.tx*cardW : from.tx`（§2.4 备注）                                |
| 7 | TS 类型：`CanvasRenderingContext2D` vs `OffscreenCanvasRenderingContext2D` 不兼容 | 统一绘制函数签名冲突                                               | 定义 `Ctx2D` 联合类型贯穿 composer 全部绘制函数                                                                     |
| 8 | 缩放图标时徽章/计数大小不统一（有的卡片大、有的小） | 尺寸变化过渡帧把旧尺寸 `lastFullRef` 等比缩放，角标是固定 px、被一并缩放；而新尺寸即时合成的角标是固定 px → 两批卡片并存 | `redrawAtSize` 过渡帧画完 scaled lastFullRef 后，再叠一层**当前尺寸的 front**（不透明、恰好覆盖旧前板区）并按当前尺寸重画固定 px 角标 → 过渡帧与最终帧角标严格等大（§3.7 抽取的 `paintStaticState` 同一实现） |
| 9 | 缩放图标后缩略图叠加出多层 | `canvas.width = Sd*res` 前后两次赋**相同值**时，部分 WebView2/Chromium 不会重置 backing → 连续 `redrawAtSize` 的不同中间尺寸 scaled 位图互相叠加 | `redrawAtSize` / `drawFull` 在 `setTransform` 后显式 `clearRect(0,0,S,S)` 清整块再绘制（不依赖 width 赋值触发重置） |
| 10 | 悬停先闪白卡、再出缩略图 | `ensureImgsAndAnimate` 在 imgs 未解码时先用**空 imgs** `animate(1)`（画白卡），解码完成后再重播真图 | 有图源但未解码时不再先播白卡动画：保持静止位图，解码完成且仍在悬停才从静止态用真图起动画；仅 0 图源时保留灰卡动画（与 DOM 一致） |
| 11 | 悬停结束停在白色卡片、缩略图不出现 | 离开动画最后一帧若用占位卡 imgs 就停在白卡，动画结束后无人把静止位图画回去 | 抽出 `paintStaticState`；`animate` 离开方向（dir<0）播完即在 completion 恢复静止位图；imgs 未就绪时 `mouseleave` 不播反向动画 |
| 12 | 重启/硬刷新后部分文件夹缩略图长期不显示（灰卡），DOM 版正常；悬停无效、滚动一段时间才恢复 | ① 上游 `FolderThumbnail` 预览加载 effect 的 cleanup `abort()` 把在途 `getThumbnail` 丢弃（发出前即被 batcher 过滤）→ `previewSrcs` 恒空；② canvas 对 0 图源 `composeFull` 走占位分支**返回"成功"灰卡位图并缓存**，组件据此停止重试 | ① `FolderThumbnail` 不再传 signal：effect cleanup/虚拟化卸载不中断底层生成，`ThumbnailBatcher` 成功仍写 `getGlobalCache`，卡片重挂载直接命中；另加有界退避补试（1.5/4/9s）覆盖启动期后端忙碌。② 诊断区分 `grayOk`（0 图源灰卡"成功"）并修正 `stuck()` 判定，使此类灰卡可被 `__SPRITE_DIAG__` 识别 |

***

## 5.1 诊断工具（spriteDiag.ts，v4 新增）

- 纯模块（不引入 Tauri/window，避免打进 worker bundle），环形缓冲 + 每文件夹聚合状态；`composeFull`/`loadImage`/worker 解码/组件重试链路埋点。
- worker 与主线程模块状态不共享 → worker 每次合成后 `drainAll()` 排空回传，主线程 `replayAll()` 合并（事件 + 聚合 + src 图例）；src 短 id 主线程 `S*` / worker `W*` 前缀防撞号。
- warn/err 事件自动镜像 `console.warn('[SPRITE_DIAG] …')` → 直接落进 webview 控制台日志文件，复现无需卡点执行命令。
- 控制台入口：`__SPRITE_DIAG__.print()/stuck()/save()/verbose()/mirror()/reset()/health()`（挂载于 spriteCache 侧，save 落盘 `{cacheRoot 上级}/sprite-diag/`）。
- 已知行为（未改）：`Ctrl+Shift+R` 被 `useKeyboardShortcuts`（`ctrlKey && key==='r'`，未排除 shift）`preventDefault` 拦截为应用内目录刷新，**无法触发页面硬刷新**；调试请用 DevTools 控制台 `location.reload()`。

***

## 6. 性能数据（滚动性能报告）

开启方法：`window.__scrollPerfEnable(true)` 或设置内开关，`scrollProfiler` 输出到控制台与 `…/scroll-perf/scroll-perf-xxx-<时间戳>.txt`。Canvas 模式额外输出一行：

```
Sprite 文件夹图标: 合成 N | 缓存命中 N | 失败 N | 取消 N | 队列剩余 N | 缓存 N | 渲染分辨率 2x (设备 dpr N)
```

实测要点（本机 WebView2 / 2000+ 文件量级）：

- **队列排空**：短时大量卡片进出视口时，队列峰值可达数百条；静止后心跳泵以 macrotask 链快速排空（`合成 ok=56 null=0 cancel=15` 一类日志表示大部分命中/成功，取消来自虚拟化卸载）。

- **滚动中零合成**：滚动期间 `composed` 增量为 0（只排队），帧耗时显著低于 DOM 版（DOM 版滚动中仍有大量合成层重算）。

- **渲染分辨率**：报告行确认 `渲染分辨率 2x (设备 dpr 1)`，角标/缩略图清晰度与 DOM 版持平。

- 结论：Canvas 版滚动帧成本已接近纯图片卡水平；仍有优化空间见 §7/§9。

***

## 7. 性能与内存预算

| 指标          | 现状                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| 每图标合成层数     | **1**（一张位图 + canvas 元素，与图片卡同级）                                                                       |
| 滚动帧开销       | 纯 `drawImage` 贴图；合成只在静止时发生                                                                           |
| 悬停动画        | 仅动画期间 rAF 逐帧（单卡 \~4 次 draw\*），300ms 后停止；预览解码延迟到首次悬停                                                  |
| 内存          | layerCache（back/front/shell/staticBody）数量 = 3 类 × 2 主题 × 尺寸档 × res，很小；full LRU 96 条 × \~380KB ≈ 36MB |
| 合成分辨率       | 位图 2x + canvas backing 2x → GPU 1x CSS（锐利）                                                           |
| FULL\_LIMIT | 96（v2 计划 256≈100MB 过大，2x 后降为 96 ≈ 40MB）                                                              |

***

## 8. 边界情况与兼容性

| 情况                                        | 处理                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 无 OffscreenCanvas / transferToImageBitmap | `isSpriteSupported()` false → 自动 DOM 版（无需手动切）                                                         |
| 预览图加载失败/超时                                | `loadImage` → null → 灰阶占位卡；组件继续可用                                                                     |
| 0/1/2/3 张预览                               | 按 §2.4 边界复刻；扇形仅 ≥2 张                                                                                  |
| 主题切换                                      | canvas backing 不重分配，仅 `theme` 依赖变化触发重绘/重取位图（layerCache 按 theme 分键）                                    |
| 尺寸变化（窗口/面板）                               | ResizeObserver → size → canvas backing 重分配（S≤0 跳过首帧）                                                  |
| count===0                                 | 角标照常显示「0」（`count !== undefined`）                                                                      |
| 拖拽导出缩略图 / FileGrid 拖拽图                    | 走手写 SVG 逻辑，与本方案无关，不动                                                                                  |
| 远程（安卓/LAN）文件夹                             | `previewSrcs` 走 `getRemoteThumbnailUrl`，同链路合成；解码走 `<img>` 由 folderTilesRenderer 的 `isDarkTheme` 等提供兼容 |

***

## 9. 后续优化方向（下个会话参考）

- **Worker 合成**：把 `composeFull`/图片解码移入 Web Worker + OffscreenCanvas 主线程转移，进一步释放主线程（当前 idle 方案已达标，属可选增强）。

- **尺寸分桶**：当前 layerCache/staticBody 按实际 size 分键，尺寸档增多会放大缓存数；如观测到内存增长可引入 v2 的 48px 步长分桶（含 1.15 系数换算）。

- **Rust 端预合成**：src-tauri 后台预合成外壳/完整位图返回文件，前端加载即得，彻底免合成（后续迭代）。

- **更多性能对比**：用 `__scrollPerfEnable` 在相同滚动手法下记录 DOM 版 vs Canvas 版两份日志（p95 帧耗、掉帧率、Long Task 数），补充 §6 量化表格。

***

## 10. 回滚

- 设置项默认 `classic`（DOM），Canvas 版是**可选项**，切换即回退，不动现有 DOM 实现。

- `isSpriteSupportedSafe()` 门控保证低版本 WebView 自动降级；任何回归均可一键切回 DOM 版，不阻塞发版。

