# Kotlin 安卓端瀑布流 FLIP 修复 — 会话记录（2026-09-07）

> 本文供后续会话接续使用。分支 `Mobil`，改动**尚未提交**。
> 涉及文件：`kotlin-app/app/src/main/java/com/aurora/gallery/kotlin/ui/components/{GridPinchFlip,RecyclerGrid,FileGrid}.kt`、`MainActivity.kt`。
>
> **2026-09-07 下午第二轮**：用户实测（真机截图 C1/C2）反馈松手跳变、文件名灰字、内容盖标题栏，已全部修复并模拟器量化验证通过，见文末「第二轮修复」章节。

## 任务背景

用户要求瀑布流（MASONRY）视图具备与网格一致的「跟手双指三档捏合 + FLIP 落档」，四条验收：
1. 跟手三档预览（原已实现）；
2. 图标变化后页面位置不跳动；
3. FLIP 最后的样子就是最终布局（落档不能突然再跳）；
4. 布局位置正确（用户截图中下半屏出现重叠）。

第一轮修复后用户反馈"效果非常糟糕：页面下方捏合时锚点像在下方，FLIP 把图片全部往下移动"。第二轮（本次）通过字节码级核对 + 模拟器实测定位并修复。

## 关键事实：RecyclerView 1.3.2 StaggeredGridLayoutManager 字节码核对结论

这些是从 Gradle 缓存的 AAR 反编译逐一验证过的，是模拟器模拟与真实布局逐位一致的基础：

- **列选取**：`getNextSpan` 先问 `preferLastSpan(layoutDirection)`。
  - 垂直 + LAYOUT_END（向下铺）→ false：扫描 0..spanCount-1，取**底边最小**列，strict `<` → **并列取最左**；
  - 垂直 + LAYOUT_START（向上回填）→ **true**：扫描 spanCount-1..0，取**顶边最大**列，strict `>` → **并列取最右**。
  - ⚠️ 模拟若把 backward 的并列也写成取最左，锚点上方整片区域的列分配会**镜像错位**（本次重大 bug 之一）。
- **冷启动（无 children）**：span 全空，fill 的空列默认线 = `getStartAfterPadding()`；从 `mPendingScrollPosition` 起向下铺，先 LAYOUT_END 铺满视口再 LAYOUT_START 向上补 → 与离线模拟**同构**。`childCount==0` 时 onLayoutChildren 的 span 播种块被跳过（seeding 无效），但实测锚点仍精确落在 `scrollToPositionWithOffset` 的目标上（由后续 fixAnchor 的 scrollBy 收敛，v2/v3 日志 drift=0/29）。
- **短边滚动拒绝**：内容底边未到视口底（或顶边未到视口顶）时，Staggered **拒绝向该方向滚动**（fill 尾部返回剩余 gap）。这就是"列表底部捏合落档后内容整体下移一个视口"的机制——fixAnchor 的 scrollBy 完全无效（v1 日志 drift=856/1140，playFlip 锚点 delta=整屏）。
- **列宽/inset 全是整数除法**：`mSizePerSpan = innerWidth / span`；装饰 inset 左 `gap*col/span`、右 `gap*(span-1-col)/span`；顶 inset 规则 `position >= span ? gap : 0`（满宽 header 无任何 inset）。封面高必须与 adapter `applyCellWidth` 的 cell 同式：`((inner-(span-1)*gap)/span)`。
- `setSpanCount()` 会重建空 Span 数组并清 LazySpanLookup；**`invalidateSpanAssignments()`（1.3.2）只做 `mLazySpanLookup.clear()+requestLayout()`，不清 mAnchorInfo.mValid/mInvalidateOffsets**（与新版不同，勿凭记忆）。
- 1.3.2 Staggered **没有** `calculateExtraLayoutSpace`（GRID 版靠它预填，Staggered 只能手工预填）。
- 满宽 header 通过 `appendViewToAllSpans` 挂进所有列，之后所有列线 = header 底。
- `scrollToPositionWithOffset`：children 已挂载时 offset 语义是**增量**（mOffset = startAfterPadding+offset−decoratedStart(anchor)）；children 未挂载时 `assignCoordinateFromPadding`（offset<0 时 mOffset=offset 原值，否则 startAfterPadding+offset）。

## 修复清单

### 1. `GridPinchFlip.kt` — MasonryPinchController 重写
- 模拟改为**复刻冷启动布局**：所有列从种子线起步、锚点是第一个 item 落 col 0；向前放底边最小列（并列取最左）、向后放顶边最大列（**并列取最右**，见上）；
- 种子 = `anchorTop − topInset(anchorPos)`；真实布局经 fixAnchor 平移后与模拟坐标**逐位一致**（模拟的绝对坐标就是最终布局坐标）；
- **滚动可行性钳制 δ**：建表后取 contentTop/contentBottom，`δ上界 = paddingTop − contentTop`（列表顶钉视口顶）、`δ下界 = viewportHeight − paddingBottom − contentBottom`（列表底钉视口底），δ=clamp(0, 下界, 上界)，全量叠加到 `topOf`；
- `SimTables{span,colOf,topOf,leftOf,widthOf,delta}` 双槽缓存（span+count 键控），`begin()` 时**必须清缓存**（跨手势同 span 会复用旧锚点的表）；
- 新增 `commitAnchorTop`（= topOf[anchorPos]，即钳制后的锚点目标）供落档使用；`pinchAnchorPos/pinchAnchorTop` 保留原值；
- `begin()` 会取消上一轮未完成动画并清 transform（快速连续捏合防叠移）。

### 2. `RecyclerGrid.kt`
- `animateStaggeredSpanChange` 改为**冷启动换档**：captureFlip（记录视觉位置+scale）→ 换全新 `AuroraStaggeredLayoutManager`（span 记账从零开始，首个布局与模拟同构）→ 新 LM 上 `scrollToPositionWithOffset(锚点, commitAnchorTop − paddingTop)` → `runFlipWhenLayoutApplied` 里 `fixAnchor`（scrollBy 精确对齐，同时把锚点上方补齐）+ `playFlip`；superseded 守卫改为比对 `rv.layoutManager === newLm`；
- `PinchAnchor(pos, top)`（internal）：捏合锚点透传（onPinchEnd 记录 → update 消费一次）；masonry 落档用 `commitAnchorTop`；
- `captureFlip/playFlip`：快照记录 `oldScales`，收尾动画把 scale 一起归位（修松手瞬间尺寸硬跳；GRID 路径同样受益）；
- `PinchGridSpanListener`：新增 `rvRef`、`lastInstance`、`debugInjectPinch(scale, steps, stepDelayMs)`——不走真实触摸直接驱动生产捏合回调（先 `rv.stopScroll()`）。

### 3. `FileGrid.kt`
- `AuroraStaggeredLayoutManager`：构造加 `gapPx`；`prefillBelow` 重写——列号用 `LayoutParams.spanIndex`、内容宽 = `sizePerSpan − 左右 inset`（`measureChildWithMargins(v, inner−(sizePerSpan−insets), 0)`，先 `calculateItemDecorationsForChild`）、链式记账含 `pos>=span` 顶 gap、满宽 header 无 inset；手工预填的 view 打 `PREFILL_TAG`，**`scrollVerticallyBy`/`onLayoutChildren` 前先 `stripPrefilled` 回收**（增量 fill 会按列线重铺同一批 position 造成重影——旧实现"下半屏重叠"的直接来源）；
- 预填改为**延迟一轮**：commit 的 `fixAnchor` scrollBy 会回收预填 view，所以顺序是 fixAnchor → playFlip → `newLm.invalidateSpanAssignments(); newLm.pendingExtraPrefill = true; rv.requestLayout()`；
- `createLayoutManager` 增加 gapPx 参数；staggered 分支传入 `isFullSpanAt`/`gapPx`/`pinchAnchor`；
- adapter 增加 `masonryPinch` 引用，`onBindViewHolder` 对两个控制器都调 `applyToNewChild`。

### 4. `MainActivity.kt`
- 仅模拟器（`isEmulator()` 判定）注册 `aurora.debug.PINCH` 广播 → `PinchGridSpanListener.lastInstance.debugInjectPinch(scale, steps)`。

## 模拟器验证环境（已搭好，可复用）

- AVD：**aurora35**（`system-images;android-35;google_apis_playstore_tablet;x86_64`，pixel_tablet，2560x1600 横屏，density 2.0）。
  - 创建命令：`avdmanager create avd -n aurora35 -k "system-images;android-35;google_apis_playstore_tablet;x86_64" -d pixel_tablet`；
  - ⚠️ 创建后 config.ini 的 `image.sysdir.1` 会带错误前缀 `Sdk\`，需删掉前缀才能启动；
  - 启动：`emulator -avd aurora35 -no-snapshot-load -no-boot-anim -gpu auto -port 5554`，必须设 `ANDROID_SDK_ROOT`。
- **安装必须 `adb install -r --abi arm64-v8a`**：Rust 核心 `libaurora_core.so` 只有 arm64，x86_64 安装会 `UnsatisfiedLinkError` 崩溃（模拟器支持 ARM 转译）。
- 种子数据：64 张多宽高比 JPEG 已推到 `/sdcard/Pictures` 并入 MediaStore（生成脚本 `C:\tmp\aurora-seed\gen.ps1`）。
- 捏合注入：`adb -s emulator-5554 shell am broadcast -a aurora.debug.PINCH --es scale 0.75`（<1 收拢列数变多，>1 张开）。
- 权限已 grant（READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE）。

### 验证操作 gotchas
- 屏幕 2560x**1600** 横屏：`input swipe` 坐标必须在界内（y≤1600），出界直接被拒绝（不 clamp），且会导致 `rvRef` 不被赋值、注入空跑；
- Git Bash 路径改写：推文件用 `//sdcard/...` 或 `MSYS_NO_PATHCONV=1`；uiautomator dump 的目标路径同理；
- `uiautomator dump` 在 UI 动画中会失败并留下**旧文件**——读之前确认 dump 命令成功；
- **坐标系**：uiautomator bounds 是屏幕坐标；日志里 fixAnchor/锚点 top 是 **RV 坐标**（RV 顶部在屏幕 ≈y200，标题+chip 行占约 200px）。对账时要减掉；
- 真机（adb-R52T701VA1J…）一直连着，操作模拟器时所有命令必须 `-s emulator-5554`。

## 验证结果对比（同为"列表底部收拢"最差场景）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| fixAnchor drift | 856 / 1140（scrollBy 被拒，完全无效） | 0 / 29（精确收敛） |
| playFlip 锚点 delta | 856 / 950（整屏漂移落在错误布局） | 0（预览延续，落位=目标） |
| 落定布局 | 内容整体下移一个视口 | 列表底边钉在视口底，img_35 实测 RV-y=51 与日志一致 |
| OVERLAP/崩溃/重复卡片 | 有重叠 | 无（uiautomator 全量 dump 校验 img 编号唯一） |

## 遗留与备注（下一会话可接手）

1. **GRID（PinchFlipController）未动**：用户确认网格趋近完整。但网格理论上存在同样的"列表短边内容不足"问题（fixAnchor scrollBy 被拒），若用户后续反馈可按同样 δ 钳制思路处理。
2. **`[FLIP-ModeSwitch]` 陈旧闭包**：模式切换后 `afterStableLayout` 闭包可能在之后某次布局再触发（v2/v3 都在第二次捏合时观察到一次 `drift=0` 的重放，有 `appliedMode != mode` 守卫但观察到了；机制未完全查清，影响有限）。可作为独立小项排查。
3. **模拟器 scaffold 视觉怪癖**：滚动后卡片会画到标题/chip 行上面（z 序 + 无裁剪），这是 `App()` 临时 scaffold 的既有现象，与 FLIP 无关，真机正式 UI 无此问题。
4. 诊断日志：`[MasonryPinch] begin/sim/visual`、`[FLIP] staggered cold-start/fixAnchor/anchor`、`[Cell]`。`visual` 采样**不**再做重叠判定（跨列迁移在预览中途天然交叠，属列数变化 FLIP 的正常观感；落位由真实布局决定不可能重叠）。
5. 提交：改动未 commit（分支 Mobil）。文档：本文件。
6. 模拟器镜像建议真机最终验收：真实双指手势的 ScaleGestureDetector 路径与注入路径共用同一组回调，理论等价，但手感（progress→时长映射、阈值）需要真人确认。

## 常用命令

```bash
# 构建+安装（模拟器）
cd kotlin-app && ./gradlew :app:assembleDebug
adb -s emulator-5554 install -r --abi arm64-v8a app/build/outputs/apk/debug/app-debug.apk

# 启动模拟器（若未运行）
export ANDROID_HOME=/c/Users/Misaki/AppData/Local/Android/Sdk ANDROID_SDK_ROOT=$ANDROID_HOME
$ANDROID_HOME/emulator/emulator -avd aurora35 -no-snapshot-load -no-boot-anim -gpu auto -port 5554 &

# 注入捏合（App 处于瀑布流视图时）
adb -s emulator-5554 shell am broadcast -a aurora.debug.PINCH --es scale 0.75

# 日志
adb -s emulator-5554 logcat -d -s AuroraKotlin
```

---

## 第二轮修复（2026-09-07 下午）：真实布局预览 + 三项视觉问题

### 用户反馈（真机截图 C1/C2，瀑布流收拢松手）

1. 松手瞬间画面再跳：文件名大小、布局、图标圆角都变了；
2. 文件名是浅灰看不清；
3. 布局超出顶部标题栏（滚动后内容画进标题/chip 行，真机可复现，非模拟器特有）。

### 根因与修复

1. **预览改真实 measure/layout（`MasonryPinchController.applyChildReal`）**。
   transform 缩放式预览无论进度多少，末态（缩小-scale 的文字/圆角/间距）都不等于最终布局
   （自然文字、12dp 圆角），松手必然跳。现改为按插值几何对可见卡片手动
   `cover.layoutParams.height 改写（不 requestLayout）→ measure(EXACTLY w, UNSPECIFIED) → layout()`，
   progress=1 的预览与冷启动布局逐位一致，松手 FLIP delta≈0、零跳变。settle 也改为
   ValueAnimator 把进度插值回 0 重放手动布局（结束几何==原布局，无需 RV 参与）；
   `begin()` 会摘牌取消未完成的 settle 并先 `applyProgress(rv,0f)` 恢复原几何再取 origins。
2. **playFlip 起始 scale 连续化（RecyclerGrid）**：FlipSnapshot 记录**视觉宽度**
   （layout 宽×scaleX），收尾起始 scale = 视觉宽/新布局宽。旧实现直接沿用捕获时的 scaleX
   （相对旧布局宽），叠到新布局宽上会先硬跳再动画。GRID 路径同样受益。
3. **冷启动判据被预览污染（实测发现）**：第一版真实预览把 captureFlip 记录的锚点宽度
   变成了目标档宽度，「宽度变化」判据永远不成立 → fixAnchor/playFlip 被跳过 →
   预览末态与落定间出现整体 7~9px 单帧硬切且日志无 fixAnchor。
   `runFlipWhenLayoutApplied` 新增 `layoutApplied` 参数，瀑布流冷启动路径改判
   `layoutManager === newLm && childCount > 0`。
4. **文件名灰字**：文件名像素 (229,229,229)=深色主题 textPrimary 画在白底上。
   窗口 XML 主题固定 `Theme.Material.Light`，而 Compose 跟随系统深色 → 调色板错位。
   `MainActivity` 改 `AuroraTheme(darkTheme = false)`（与窗口固定浅色一致；
   若将来要支持深色，需同时把 XML 主题换 DayNight）。
5. **内容盖标题栏**：Compose interop 链路默认不裁剪，RV 子内容滚出顶边直接画进标题区。
   `MainActivity` FileGrid 改 `Modifier.fillMaxWidth().weight(1f)`（RV 只占标题/模式条之下）；
   FileGrid 的 RV 加 `clipToOutline=true` + 显式 rect outlineProvider（RV 无背景时
   BACKGROUND provider 的 outline 是 null，不显式给不生效），另在 AndroidView modifier
   加 `clipToBounds()` 双保险。裁剪到 RV 外边界，clipToPadding=false 的 padding 穿越
   观感不受影响（实测确认）。

### 模拟器量化验证（子智能体实测，证据在 C:\tmp\flipv3\，v2 后缀）

- 实验 A（收拢 6→9 提交）：fixAnchor 出现、drift=9 被校正；`animated=0 skipped=19
  maxDelta=0.0`（收尾布局与快照逐位一致）；预览末态 vs 落定**逐卡 delta 全 (0,0)**，
  旧卡像素差异 224px/125 万 px（抗锯齿级）。
- 反向（9→6 提交）：drift=9、delta 0/±1px，PASS。
- 实验 B（未过阈值退回）：退回后截图与捏合前 **MD5 完全相同**。
- 实验 C：标题行彩色卡占比 72.44%→**0.00%**；chip 行 84.16%→4.69%（残余为选中 chip
  自身）；裁剪线在 RV 顶边干净截断；文件名 median RGB (30,41,59)=#1E293B 深色可读。
- GRID 回归：捏合跨档提交动画正常、fixAnchor drift=0，无回归。
- 测试 gotcha：调试注入前必须先真实触摸一次列表（rvRef 才被赋值），否则广播静默无效。

### 第二轮遗留

1. **GRID（PinchFlipController）预览仍是 transform 缩放式**：文字/圆角捏合中会缩小、
   松手有轻微视觉变化（用户已确认网格可接受）。若要统一观感，可复用 applyChildReal 的
   手动 measure/layout 思路改造（settle 同样换 ValueAnimator）。
2. 深色模式支持：当前刻意固定浅色；要做的话 XML 主题换 DayNight + `darkTheme` 透传系统值。
3. 诊断日志沿用：`[MasonryPinch] begin/sim/visual`、`[FLIP] staggered cold-start/fixAnchor/anchor`。

---

## 第三轮修复（2026-09-08）：缩小预览底部空白 → 架构重构为「真实冷启动捕获」

### 问题
缩小（收拢）预览时视口底部大面积空白，松手才刷新；放大方向无此问题。

### 排查结论（多轮插桩 + 像素级取证）
1. 手工预填的 addView 会排出额外布局 pass（ViewGroup.addView 无条件 requestLayout，onLayoutChildren 期间不拦截）→ 预填自毁。修复：androidx 包内 shim `RvRequestLayoutGuard` 暴露 start/stopInterceptRequestLayout，预填在拦截深度内运行。
2. 捕获/预填 pass 复用陈旧 AnchorInfo → 列表跳回旧锚点。修复：先 invalidateSpanAssignments。
3. **根本性发现：离线模拟的列分配与真实 getNextSpan 系统性分歧**（滚动场景 47/47 全错，行为内列排列不同、TOP 却几乎一致），多种填充假设均无法离线复刻。模拟路线不可救。
4. `afterStableLayout` 的嵌套重注册会让闭包漂移到任意久之后的布局上执行（模式切换 FLIP 在捏合开始的布局上重放，scrollToPosition 拽列表回顶部）。修复：加 750ms 执行时限；另加 flipEpoch 代数守卫。

### 最终架构：真实冷启动捕获（MasonryPinchController 重写）
- 第一次有效捏合进度（≥落档阈值 0.5）时执行「捕获舞蹈」：换入目标档位全新 AuroraStaggeredLayoutManager（纯冷启动）→ 完成 pass 后逐位置记录 left/top/宽/封面高 → 换回【原 LM 实例】（其 LazySpanLookup 保留原始列分配，逐位还原捏合前布局；须重申 scrollToPositionWithOffset 锚点）→ 预览放行。
- 预览 = 手动 measure/layout 在「捏合前布局 ⇆ 捕获的真实目标布局」间插值；提交的冷启动与捕获同输入同机制 ⇒ 天然逐位一致（实测 commit FLIP animated=0 skipped=46 maxDelta=0.0）。
- δ 钳制沿用离线模拟的范围估计（只影响整体平移；填充对锚点坐标平移等变）。
- 捕获 pass 与恢复 pass 都开下方预填（wantsPrefill 钩子），保证预览物料充足。
- cellWidthPx 静默切换钩子（onCaptureStart/End）：捕获 pass 必须按目标档位封面高绑定；恢复后 refreshCellWidths() payload 刷新校正。

### 实测状态（emulator-5554 自测 + 截图取证）
- 缩小+提交（滚动半屏，scale 0.6）：预览末态铺满视口、提交 maxDelta=0、animated=0 ✓
- 退回（scale 0.85，低于阈值）：前后截图 diff=0 ✓（舞蹈改在 ≥0.5 才启动，低于阈值不动布局）
- 反向放大（scale 1.5）：提交 maxDelta 从 2212 降至 ~198（个别卡垂直残差），待进一步收敛
- GRID、防重影唯一性：此前轮次已 PASS，本轮架构未再引入回归（待完整回归）

### 待办
1. [PinchFix]/DebugRecyclerView 临时诊断日志待清理（FileGrid.kt / RecyclerGrid.kt / GridPinchFlip.kt）。
2. 反向放大的 ~198px 残差定位（疑与恢复 pass 的重推导时机相关）。
3. 真机最终验收（调试注入与真实手势共用回调链，但手感需真人确认）。

### 撤销（2026-09-08，应用户要求）
第三轮（缩小空白修复尝试）整体效果变差且破坏了已确认的跳动/文件名修复，已**全部撤销**，代码恢复到第二轮验证通过的状态（真实 measure/layout 预览 + 零跳变 + 文件名/标题栏修复）：
- 还原 GridPinchFlip.kt 的 MasonryPinchController（移除真实捕获架构/状态机/布局回调/等待门控）
- 还原 RecyclerGrid.kt（afterStableLayout 时限、fixAnchor/flip 日志插桩）
- 还原 FileGrid.kt（DebugRecyclerView、RvRequestLayoutGuard 预填包装、wantsPrefill、flipEpoch、setCellWidthSilently/refreshCellWidths、捕获构造参数）
- 删除 androidx/recyclerview/widget/RvRequestLayoutGuard.kt
- 保留：第二轮全部修复（MainActivity 固定浅色 + weight(1f)、RV 裁剪、真实预览、playFlip scale 连续、layoutApplied 判据参数）
- 回退版模拟器冒烟：退回 diff=0、缩小提交正常、无崩溃 ✓

**遗留（下一轮若再做缩小空白，须记住的教训）**：
1. 手工预填 addView 会排额外布局 pass 导致预填自毁（需 androidx 包内 shim 拦截，文件曾被删，可从 git 历史找回思路）；
2. 恢复布局用新建 LM 会重启列分配链（列排列与原布局不同），必须换回原 LM 实例并重申锚点，但即便如此退回终态仍难逐位还原（链重启的排列差异）—— cancelled-pinche 的还原是真实布局预览的根本难题；
3. 离线模拟列分配与真实 getNextSpan 有系统性分歧（47/47），不要回到模拟路线。

---

## 下轮方案：彻底方案 —— 「真实重布局」捏合（对齐 Google 相册），可直接开工

### 核心思想
放弃「假预览」这条路线的全部包袱（离线模拟、手工预填、恢复还原、拦截 shim）。捏合期间**每次跨越档位边界就做一次真实的 span 切换 + 真实布局**，跨档瞬间用现有的 `animateStaggeredSpanChange` 冷启动 + FLIP 机制呈现动画。布局永远是真实的，空白/恢复/模拟分歧三类问题**从根上不存在**：
- 无手工预填 → 没有预填自毁、没有拦截 shim 需求（LM 自己把视口填满，包括底部）；
- 无假预览几何 → 不需要离线模拟列分配（47/47 分歧无关紧要），落档即所见；
- 无恢复需求 → 跨档是「真实发生过的布局变更」，取消捏合只需把档位切回去（再一次真实重布局），不存在逐位还原难题。

### 为什么可行（本轮排查已验证的事实）
1. `animateStaggeredSpanChange` 的冷启动 + fixAnchor + FLIP 机制在**顶部场景已验证零跳变**（maxDelta=0），滚动场景的 2184 大 delta 是「真实旧布局 → 真实新布局」的合法 FLIP 行程，观感是卡片滑向新格位而非 bug。
2. 跨档只在捏合越过档位边界时发生（一档手势至多 1~2 次），每次一个布局 pass，性能可控——不是每帧全量重布局。
3. FLIP 起始 scale 连续化（oldVisualWidths）已在位，跨档动画的尺寸衔接已验证。

### 实现步骤（建议顺序）
1. **回退起点**：当前工作区（第二轮已验证状态）。删除 `MasonryPinchController` 的预览/模拟/退回全部逻辑（整个类可删），FileGrid 的 onPinchProgress 改为新的「跨档驱动」。
2. **onPinchProgress 重写**：由 scale 连续计算 `wantedLevel`（允许一次手势跨多档：用 `初始level + round(log(scale)/log(档距))` 或累计越界计数，而非现在的夹一档）；当 `wantedLevel != appliedLevel` 且手势活跃 → 调用 `liveSpanChange(wantedLevel)`。
3. **liveSpanChange(level)**：复用 `animateStaggeredSpanChange(rv, lm, decoration, targetCols(span, level), flipDuration, isFullSpanAt, gapPx, pinchAnchor=null)`（非捏合路径已能自行取锚点）。要点：
   - 锚点：非捏合分支已有「top 最小可见图」扫描 ✓；
   - `appliedLevel = level` 记录在同一帧生效，防重复触发；
   - itemAnimator 已为 null，跨档是硬重排 + FLIP 动画 ✓。
4. **取消语义**：松手时不需要 settle——已跨的档就是新档位。若产品要求「松手时低于阈值回退」，则记录手势起始 level，松手时若 `wantedLevel != startLevel && scale 回到 1 附近`，再触发一次反向 liveSpanChange（同机制）。
5. **手感细化（二期可选）**：跨档之间可加视觉连续层——按当前 scale 对卡片做轻微 transform 缩放（纯装饰，不做几何承诺，跨档时由 captureFlip 清零衔接）。一期可跳过。
6. **清理**：删除 MasonryPinchController、FileGrid 的 masonryPinch 相关接线、staggeredAnchor 透传、GridPinchFlip 的 COMMIT_THRESHOLD 双档逻辑（GRID 的 PinchFlipController 是否也迁到此机制，另行决定，勿顺手改）。

### 风险与对策
- **跨档频繁触发**（手抖在边界来回）：对 wantedLevel 做去抖（如距上次跨档 ≥200ms 或 scale 变化 ≥0.05 才应用）。
- **滚动场景的深位卡片 FLIP 行程大**：合法动画，若观感差可对 missing/大 delta 卡片改为直接落位（playFlip 内按 delta 阈值分流）。
- **连续跨两档**（一次手势跨 6→9→12）：逐档触发即可，机制天然支持；注意 appliedLevel 同帧去重。
- **GRID 模式**：不受影响（本方案只重写 MASONRY 的捏合路径）。

### 验收清单
- [ ] 缩小跨档：视口全程铺满（LM 自填），无空白
- [ ] 跨档瞬间：锚点图位置稳定（fixAnchor drift≈0），FLIP 动画为卡片滑向新格位
- [ ] 连续跨两档不丢步、不重复触发
- [ ] 松手低于阈值：按产品语义回退（反向 liveSpanChange）或保持（二选一，先实现「保持」）
- [ ] GRID 模式回归正常
- [ ] 滚动/顶部两场景、uiautomator 卡片唯一性、无 FATAL
