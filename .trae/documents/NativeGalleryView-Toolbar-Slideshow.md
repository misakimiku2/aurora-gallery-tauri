# NativeGalleryView 顶部工具栏扩展 + 幻灯片功能

## 摘要

在 NativeGalleryView 顶部工具栏增加删除、分享、幻灯片按钮（已完成按钮添加），加宽按钮间距（已完成），并实现这三个功能。同时在"更多"菜单中增加"幻灯片设置"选项，可设置播放间隔、过渡效果（无/淡入淡出/平滑移动）、图片逐渐放大（Ken Burns）、随机播放。

## 当前状态分析

### 已完成（上一轮会话）
- Drawable 图标已创建：`ic_lucide_trash.xml`、`ic_lucide_share.xml`、`ic_lucide_play.xml`、`ic_lucide_pause.xml`
- NativeGalleryView.kt 已添加：
  - 字段 `slideshowRandom`、`slideshowZoom`（L146-147）
  - 字段 `slideshowBtn: ImageView`（L183）
  - `makeIconButton()` 函数（L536）
  - `buildTopBar()` 已添加 delete/share/slideshow 按钮（L508-519）
  - `open()` 已解析 `isRandom`/`enableZoom`（L1216-1217）
  - `makeImageButton()` 已使用 14dp density-adjusted padding（L524-525）

### 待完成
1. `applyTheme()` 未处理 ImageView tint（仅处理 TextView）
2. `shareCurrentImage()` 方法未实现（L509 引用但未定义）
3. `toggleSlideshow()` 方法未实现（L510 引用但未定义）
4. `slideshowRunnable` 仅支持顺序播放 + 无过渡控制（L1972-1982）
5. 无 `navigateToWithFade()` 淡入淡出过渡
6. 无 Ken Burns（图片逐渐放大）效果
7. 无 `showSlideshowSettingsDialog()` 设置对话框
8. `showMoreMenu()` 未添加"幻灯片设置"项
9. `close()` 未清理 Ken Burns 动画
10. Listener 接口缺少 `onShare` 和 `onUpdateSlideshowConfig`
11. MainActivity 未实现 `onShare` 和 `onUpdateSlideshowConfig`
12. App.tsx 未传递 `isRandom`/`enableZoom`，未添加 `onUpdateSlideshowConfig` 桥接

## 提议变更

### 1. NativeGalleryView.kt — Listener 接口（L61-86）

在 `onExtractPalette` 之后添加两个方法：

```kotlin
/** 用户点击了分享按钮。filePath 为本地文件路径。 */
fun onShare(filePath: String)
/** 用户在原生层修改了幻灯片设置，JSON 形如 {"interval":5000,"transition":"fade","isRandom":false,"enableZoom":false} */
fun onUpdateSlideshowConfig(configJson: String)
```

### 2. NativeGalleryView.kt — 新增字段

在 `slideshowZoom` 字段（L147）之后添加：

```kotlin
private var kenBurnsAnimator: ViewPropertyAnimator? = null
```

### 3. NativeGalleryView.kt — `applyTheme()` 修改（L1249-1251）

当前代码仅处理 TextView，需增加 ImageView 的 tint：

```kotlin
for (i in 0 until topBar.childCount) {
    when (val child = topBar.getChildAt(i)) {
        is TextView -> child.setTextColor(colorTextPrimary())
        is ImageView -> child.setColorFilter(colorTextPrimary())
    }
}
```

### 4. NativeGalleryView.kt — `shareCurrentImage()` 方法

新增方法，处理 LAN 图片不可分享的情况：

```kotlin
private fun shareCurrentImage() {
    val item = images.getOrNull(currentIndex) ?: return
    if (item.isLan) {
        Toast.makeText(context, "无法分享局域网图片", Toast.LENGTH_SHORT).show()
        return
    }
    listener?.onShare(item.path)
}
```

### 5. NativeGalleryView.kt — 幻灯片控制方法

替换现有 `slideshowRunnable`（L1972-1982）、`startSlideshowLoop`/`stopSlideshowLoop`/`setSlideshow`（L1984-1997）为以下实现：

```kotlin
// ====== 幻灯片 ======
private val slideshowRunnable = object : Runnable {
    override fun run() {
        if (!isSlideshowActive) return
        cancelKenBurns()
        val nextIndex = if (slideshowRandom && images.size > 1) {
            var r: Int
            do { r = (0 until images.size).random() } while (r == currentIndex)
            r
        } else {
            if (currentIndex < images.size - 1) currentIndex + 1 else 0
        }
        when (slideshowTransition) {
            "none" -> navigateTo(nextIndex, animate = false)
            "slide" -> navigateTo(nextIndex, animate = true)
            else -> navigateToWithFade(nextIndex) // "fade"
        }
        mainHandler.postDelayed(this, slideshowIntervalMs)
    }
}

private fun toggleSlideshow() {
    if (isSlideshowActive) {
        isSlideshowActive = false
        mainHandler.removeCallbacks(slideshowRunnable)
        cancelKenBurns()
    } else {
        isSlideshowActive = true
        mainHandler.postDelayed(slideshowRunnable, slideshowIntervalMs)
        if (slideshowZoom) startKenBurns(activeView)
    }
    updateSlideshowButtonIcon()
}

private fun updateSlideshowButtonIcon() {
    slideshowBtn.setImageResource(if (isSlideshowActive) R.drawable.ic_lucide_pause else R.drawable.ic_lucide_play)
}

fun setSlideshow(enabled: Boolean) {
    if (enabled == isSlideshowActive) return
    toggleSlideshow()
}
```

### 6. NativeGalleryView.kt — `navigateToWithFade()` 方法

新增方法，用于幻灯片淡入淡出过渡（在 `navigateTo` 之后添加）：

```kotlin
private fun navigateToWithFade(newIndex: Int) {
    if (isAnimating.get()) return
    if (newIndex == currentIndex) return
    if (newIndex < 0 || newIndex >= images.size) return

    cleanupSwipeAdjacentImmediate()
    cancelKenBurns()

    currentIndex = newIndex
    rotationDegrees = 0
    loadingPaletteFileId = null

    isAnimating.set(true)
    val outgoing = activeView
    val incoming = if (outgoing === primaryView) secondaryView else primaryView
    activeView = incoming

    incoming.alpha = 0f
    incoming.translationX = 0f
    incoming.visibility = VISIBLE
    loadIntoView(incoming, currentIndex)

    val duration = 400L
    outgoing.animate()
        .alpha(0f)
        .setDuration(duration)
        .withEndAction {
            outgoing.alpha = 1f
            outgoing.visibility = GONE
            outgoing.setImageDrawable(null)
        }
        .start()
    incoming.animate()
        .alpha(1f)
        .setDuration(duration)
        .withEndAction {
            isAnimating.set(false)
            listener?.onNavigate(currentIndex)
            preloadNeighbors()
            thumbnailAdapter.highlight(currentIndex)
        }
        .start()

    updateTitle()
}
```

### 7. NativeGalleryView.kt — Ken Burns 效果

新增 `startKenBurns()` 和 `cancelKenBurns()` 方法（在幻灯片区域添加）：

```kotlin
private fun startKenBurns(view: View) {
    cancelKenBurns()
    view.scaleX = 1f
    view.scaleY = 1f
    view.pivotX = view.width / 2f
    view.pivotY = view.height / 2f
    kenBurnsAnimator = view.animate()
        .scaleX(1.15f)
        .scaleY(1.15f)
        .setDuration(slideshowIntervalMs)
        .setInterpolator(AccelerateDecelerateInterpolator())
        .start()
}

private fun cancelKenBurns() {
    kenBurnsAnimator?.cancel()
    kenBurnsAnimator = null
    primaryView.scaleX = 1f
    primaryView.scaleY = 1f
    secondaryView.scaleX = 1f
    secondaryView.scaleY = 1f
}
```

### 8. NativeGalleryView.kt — `loadIntoView` onSuccess 修改（L1416-1420）

在图片加载成功后，若幻灯片活跃且开启缩放，启动 Ken Burns：

```kotlin
onSuccess = { drawable ->
    if (showProgress) progressBar.visibility = GONE
    view.setImageDrawable(drawable)
    view.setRotationDegrees(rotation)
    if (isSlideshowActive && slideshowZoom && view === activeView) {
        startKenBurns(view)
    }
}
```

### 9. NativeGalleryView.kt — `close()` 修改（L1276-1315）

在 `stopSlideshowLoop()` 调用之后（或 `activeView.animate().cancel()` 之后）添加 Ken Burns 清理：

```kotlin
cancelKenBurns()
```

（`cancelKenBurns()` 已重置 primaryView/secondaryView 的 scaleX/Y，无需额外代码）

### 10. NativeGalleryView.kt — `showSlideshowSettingsDialog()` 方法

新增方法，包含 SeekBar（播放间隔）、RadioGroup（过渡效果）、Switch（逐渐放大/随机播放）：

```kotlin
private fun showSlideshowSettingsDialog() {
    val density = resources.displayMetrics.density
    val dialog = Dialog(context)
    dialog.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
    dialog.window?.let { window ->
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
    }

    val container = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = createRoundedBg(colorDialogBg(), 12f, colorBorder(), 1f)
        setPadding((density * 24).toInt(), (density * 20).toInt(), (density * 24).toInt(), (density * 16).toInt())
    }

    // 标题
    val title = TextView(context).apply {
        text = "幻灯片设置"
        setTextColor(colorTextPrimary())
        textSize = 18f
        setPadding(0, 0, 0, (density * 16).toInt())
    }
    container.addView(title)

    // 播放间隔
    val intervalLabel = TextView(context).apply {
        text = "播放间隔：${slideshowIntervalMs / 1000} 秒"
        setTextColor(colorTextPrimary())
        textSize = 14f
        setPadding(0, (density * 8).toInt(), 0, (density * 4).toInt())
    }
    container.addView(intervalLabel)
    val intervalSeekBar = SeekBar(context).apply {
        max = 19 // 1-20 秒
        progress = ((slideshowIntervalMs / 1000) - 1).toInt().coerceIn(0, 19)
        setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                intervalLabel.text = "播放间隔：${progress + 1} 秒"
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        })
    }
    container.addView(intervalSeekBar)

    // 过渡效果
    val transitionLabel = TextView(context).apply {
        text = "过渡效果"
        setTextColor(colorTextPrimary())
        textSize = 14f
        setPadding(0, (density * 16).toInt(), 0, (density * 4).toInt())
    }
    container.addView(transitionLabel)
    val radioGroup = RadioGroup(context).apply {
        orientation = RadioGroup.VERTICAL
    }
    val transitions = listOf("none" to "无", "fade" to "淡入淡出", "slide" to "平滑移动")
    var selectedTransition = slideshowTransition
    transitions.forEach { (value, label) ->
        val rb = RadioButton(context).apply {
            text = label
            setTextColor(colorTextPrimary())
            isChecked = value == selectedTransition
            setOnCheckedChangeListener { _, isChecked ->
                if (isChecked) selectedTransition = value
            }
        }
        radioGroup.addView(rb)
    }
    container.addView(radioGroup)

    // 图片逐渐放大
    val zoomSwitch = Switch(context).apply {
        text = "图片逐渐放大"
        setTextColor(colorTextPrimary())
        isChecked = slideshowZoom
        setPadding(0, (density * 12).toInt(), 0, (density * 4).toInt())
    }
    container.addView(zoomSwitch)

    // 随机播放
    val randomSwitch = Switch(context).apply {
        text = "随机播放"
        setTextColor(colorTextPrimary())
        isChecked = slideshowRandom
        setPadding(0, (density * 4).toInt(), 0, (density * 16).toInt())
    }
    container.addView(randomSwitch)

    // 按钮行
    val buttonRow = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.END
    }
    buttonRow.addView(createDialogButton("取消", isPrimary = false) { dialog.dismiss() })
    buttonRow.addView(createDialogButton("确定", isPrimary = true) {
        slideshowIntervalMs = (intervalSeekBar.progress + 1) * 1000L
        slideshowTransition = selectedTransition
        slideshowZoom = zoomSwitch.isChecked
        slideshowRandom = randomSwitch.isChecked
        // 若幻灯片正在运行，重启定时器以应用新设置
        if (isSlideshowActive) {
            mainHandler.removeCallbacks(slideshowRunnable)
            mainHandler.postDelayed(slideshowRunnable, slideshowIntervalMs)
            if (slideshowZoom) startKenBurns(activeView) else cancelKenBurns()
        }
        // 通知前端同步设置
        val json = JSONObject().apply {
            put("interval", slideshowIntervalMs)
            put("transition", slideshowTransition)
            put("isRandom", slideshowRandom)
            put("enableZoom", slideshowZoom)
        }
        listener?.onUpdateSlideshowConfig(json.toString())
        dialog.dismiss()
    })
    container.addView(buttonRow)

    dialog.setContentView(container)
    dialog.show()
    val widthPx = (320 * density).toInt()
    dialog.window?.setLayout(widthPx, android.view.WindowManager.LayoutParams.WRAP_CONTENT)
}
```

> 注意：需确认 `createDialogButton` 方法签名。若不存在或签名不同，使用与 `showRenameDialog`/`showSourceUrlDialog` 一致的按钮创建方式。

### 11. NativeGalleryView.kt — `showMoreMenu()` 修改（L1878-1883）

在 `menuItems` 列表末尾添加"幻灯片设置"项：

```kotlin
val menuItems = listOf(
    Triple("删除", deleteTextColor) { listener?.onDelete(item.fileId) },
    Triple("重命名", colorTextPrimary()) { showRenameDialog() },
    Triple("复制到文件夹", colorTextPrimary()) { listener?.onCopyToFolder(item.fileId) },
    Triple("移动到文件夹", colorTextPrimary()) { listener?.onMoveToFolder(item.fileId) },
    Triple("幻灯片设置", colorTextPrimary()) { showSlideshowSettingsDialog() }
)
```

### 12. NativeGalleryView.kt — 新增 import

在文件顶部 import 区域添加：

```kotlin
import android.widget.RadioGroup
import android.widget.RadioButton
import android.widget.SeekBar
import android.widget.Switch
```

### 13. MainActivity.kt — Listener 实现（L164-222 区域）

在 `onExtractPalette` override 之后添加：

```kotlin
override fun onShare(filePath: String) {
    shareImage(filePath)
}
override fun onUpdateSlideshowConfig(configJson: String) {
    evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onUpdateSlideshowConfig)window.__androidViewerBridge.onUpdateSlideshowConfig('${escapeJsString(configJson)}');")
}
```

### 14. App.tsx — 传递 isRandom/enableZoom（L2429-2433）

修改 slideshow options 对象：

```typescript
slideshow: {
    enabled: false,
    interval: state.slideshowConfig.interval || 5000,
    transition: state.slideshowConfig.transition || 'fade',
    isRandom: state.slideshowConfig.isRandom || false,
    enableZoom: state.slideshowConfig.enableZoom || false,
},
```

### 15. App.tsx — 添加 `onUpdateSlideshowConfig` 桥接（L2562 区域）

在 bridge 对象的 `onExtractPalette` 之后添加：

```typescript
onUpdateSlideshowConfig: (configJson: string) => {
    try {
        const cfg = JSON.parse(configJson);
        setState(s => ({ ...s, slideshowConfig: cfg }));
    } catch (e) {
        console.error('[NativeViewer] onUpdateSlideshowConfig parse error:', e);
    }
},
```

## 假设与决策

1. **LAN 图片不可分享**：`shareCurrentImage()` 对 LAN 图片显示 Toast 提示"无法分享局域网图片"，因为 `shareImage()` 仅支持本地文件路径。
2. **onShare 不经过前端桥接**：分享直接由 MainActivity 调用原生 Intent，无需 evaluateJs 通知前端。
3. **onUpdateSlideshowConfig 经过前端桥接**：设置变更需同步到前端 state，以便下次 open() 传递更新后的值。
4. **设置不持久化到 localStorage**：与现有 PC 端 `onUpdateSlideshowConfig` 行为一致（仅 setState）。如需跨会话持久化，可后续添加。
5. **Ken Burns 使用 View.scaleX/Y**：这是渲染时变换，叠加在 ZoomableImageView 的 matrix 缩放之上。幻灯片期间用户通常不交互，若交互则 matrix 缩放叠加在 scaleX/Y 之上，可接受。
6. **"删除"保留在更多菜单**：用户仅要求"增加"幻灯片设置项，不删除现有菜单项。顶栏删除按钮与菜单删除按钮并存。
7. **过渡效果映射**：`"none"` = 无过渡（instant navigate）、`"fade"` = 淡入淡出（cross-fade）、`"slide"` = 平滑移动（现有滑动动画）。
8. **播放间隔范围**：1-20 秒，SeekBar progress 0-19 映射到 1-20 秒。

## 验证步骤

1. **Kotlin 编译**：`cd src-tauri/gen/android && ./gradlew assembleDebug`（或在 Android Studio 中编译）
2. **TypeScript 编译**：`npm run build` 或 `npx tsc --noEmit`
3. **功能验证**：
   - 顶栏显示 8 个按钮（关闭、标题、删除、分享、幻灯片、旋转、元数据、更多），间距均匀
   - 点击删除按钮 → 触发删除流程
   - 点击分享按钮 → 弹出系统分享面板（本地图片）/ Toast（LAN 图片）
   - 点击幻灯片按钮 → 图标切换为暂停，开始自动播放
   - 再次点击 → 图标切换为播放，停止
   - 更多菜单 → 点击"幻灯片设置" → 弹出设置对话框
   - 设置对话框：拖动 SeekBar 改变间隔，切换过渡效果单选，切换逐渐放大/随机播放开关
   - 点击"确定" → 设置立即生效（若幻灯片运行中，下次切换使用新设置）
   - 关闭查看器后重新打开 → 设置保留（从前端 state 读取）
