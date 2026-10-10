package com.aurora.gallery.kotlin.viewer

// 生命周期与布局助手簇（拆分清单第 24 刀）：状态栏高度自补、顶栏/抽屉顶部让位、
// 图片区钉扎（沉浸/分段 resize 期间几何冻结）、抽屉子树强制测量兜底，8 个扩展
// 函数落地（§5.1 手法，接收者 NativeGalleryView）。
// 引用的钉扎状态/嵌套类 ChromePin/slideshowHidSystemUi/DRAWER_TOP_PAD_DP 已在
// NativeGalleryView 降 internal（9 处，双向穷举，清单见第 24 刀提交说明）；
// applyTopBarTopMargin/applyDrawerTopInset 自第 22 刀起即 internal
// （NativeGalleryViewDrawer.kt 消费）；isChromeHidden/pinnedChromeChildren/
// forceLayoutRecursive 仅簇内调用，保持 private。
// 继承作用域裸标识符限定（类体内裸写走继承静态作用域、扩展里不合法，§7 第 19 条）：
// LayoutParams -> FrameLayout.LayoutParams（topMargin 在它身上，ViewGroup.LayoutParams 没有）、
// MeasureSpec -> View.MeasureSpec（定义在 View 而非 ViewGroup）。

import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout

// —— 状态栏高度自补（B2：容器真全屏后由本类自己让位）——

/**
 * 从窗口 insets 读状态栏高度。归零（沉浸隐藏中 / 尚未 attach）时保留上一个真值——
 * 冻结是刻意的，见 [statusBarInsetPx]。值变了才落 margin/padding。
 */
internal fun NativeGalleryView.syncStatusBarInset() {
    // 沉浸期间 insets 归零——冻结上一真值：按 0 重算会把顶栏**抽上去**一整个状态栏
    //（真机报障「退出沉浸时标题跳动」的同源坑）。
    if (isChromeHidden()) return
    // 零尺寸布局（查看器关闭期间父层 relayout 会以 [0,0][0,0] 摆一帧）的几何是垃圾：
    // 此时 getLocationInWindow 报过屏中位置（1212），need 被错算成 0 烤进冻结值——
    // 「钉横屏退出还原后重开，顶栏贴进状态栏」即此根因。零尺寸帧不学几何。
    if (width <= 0 || height <= 0) return
    val insets = androidx.core.view.ViewCompat.getRootWindowInsets(this) ?: return
    val statusTop = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.statusBars()).top
    val loc = IntArray(2)
    getLocationInWindow(loc)
    // ⚠ 关键：**减掉本容器自己在窗口内的顶偏移**。insets 的 statusBars 是相对**窗口**的，
    // 而本容器未必从窗口顶开始——非 e2e 窗口（荣耀 Magic2 / API29 实测）容器顶本就是 96
    //（状态栏让位由窗口完成），再自加 96 就是「双重内缩」→ 顶栏凭空低一整个状态栏
    // （B1 注释早就警告过这条，B2 自补时踩了）。于是顶栏的屏幕顶恒 =
    // max(容器顶, 状态栏底) + 8dp，e2e 与非 e2e 两种窗口下都落在同一位置。
    val need = (statusTop - loc[1]).coerceAtLeast(0)
    if (need != statusBarInsetPx) {
        statusBarInsetPx = need
        applyTopBarTopMargin()
        applyDrawerTopInset()
    }
}

/**
 * 顶栏 topMargin = 状态栏让位量（[statusBarInsetPx]，已扣容器自身顶偏移）+ 顶部间距。
 * 间距见 [TOP_BAR_TOP_GAP_DP]：2026-10-07 指挥官拍板「状态栏下方就是顶栏、中间不留
 * 空隙」→ 0；原 8dp 来自 2026-09-27 对齐图库卡片形制的内缩，已作废。
 */
internal fun NativeGalleryView.applyTopBarTopMargin() {
    val lp = topBar.layoutParams as? FrameLayout.LayoutParams ?: return
    val want = statusBarInsetPx + (resources.displayMetrics.density * NativeGalleryView.TOP_BAR_TOP_GAP_DP).toInt()
    if (lp.topMargin != want) {
        lp.topMargin = want
        topBar.layoutParams = lp
    }
}

/**
 * 抽屉顶部让位：横屏/平板的右缘抽屉是全高（顶=窗口顶），内容必须避开状态栏；
 * 竖屏底部面板钉在屏幕下缘、顶边本就在屏内，不加。
 */
internal fun NativeGalleryView.applyDrawerTopInset() {
    val d = resources.displayMetrics.density
    val side = (d * 16).toInt()
    // 竖屏底部面板：顶内边距 16→12dp（与把手条 32→20dp 一起，把「面板顶→文件名」
    // 从 48dp 收到 32dp）。横屏右缘全高抽屉额外让出状态栏（见 statusBarInsetPx）。
    val top = if (isCompactPortrait) (d * NativeGalleryView.DRAWER_TOP_PAD_DP).toInt() else side + statusBarInsetPx
    if (metadataDrawer.paddingTop != top) metadataDrawer.setPadding(side, top, side, side)
}

/**
 * 内容区钉扎：非沉浸静止时锚=当前屏幕矩形与各 chrome 子视图的本地矩形（同值赋值
 * 零开销）；系统栏被本查看器隐藏期间（含还原分段中），把图片双 buffer 与缩略图条/
 * 底部信息直接 layout 回各自的锚矩形——窗口分段 resize 时黑底向四周补位，全部内容
 * 的屏幕位置与尺寸逐帧不变（laid-out 尺寸恒定，ZoomableImageView 的 onSizeChanged
 * 不触发，resetToCenter 不重跑，缩放状态也不丢）。用 child.layout 同帧纠偏而非
 * padding/params：不产生 requestLayout 二次遍历，无「先按旧几何摆、下一帧再修正」
 * 的闪烁。幻灯片隐藏系统栏（不改 isImmersive）走同一钉扎。顶栏只在还原分段钉
 * （沉浸期间钉扎会顶住滑出量，见循环内注）。旋转后旧锚属于旧方向：失效自愈为
 * 不钉扎（原行为），非沉浸静止后重录。
 */
internal fun NativeGalleryView.applyImageAreaPin() {
    if (width <= 0 || height <= 0) return
    val loc = IntArray(2)
    getLocationOnScreen(loc)
    val now = android.os.SystemClock.uptimeMillis()
    if (!isChromeHidden() && now >= imagePinHoldUntil) {
        imageAnchorTopAbs = loc[1]
        imageAnchorBottomAbs = loc[1] + height
        chromePins.clear()
        for (v in pinnedChromeChildren()) {
            if (v.height > 0 && v.width > 0) chromePins.add(NativeGalleryView.ChromePin(v, v.top, v.bottom))
        }
        imageAnchorValid = true
    }
    if (!imageAnchorValid) return
    // 抽屉 fill/压缩有自己的图片几何（显式宽高与进度动画），不叠加钉扎
    if (drawerOpen || drawerWidthAnimator != null || drawerPanelProgress > 0f) return
    // 各子视图锚矩形随锚顶边平移回摆；clamp 进当前几何，锚异常时退化为不钉扎
    val deltaY = imageAnchorTopAbs - loc[1]
    for (p in chromePins) {
        // 顶栏在系统栏被本查看器隐藏期间不钉（2026-10-07 荣耀真机回归实锤）：滑出量
        // -topBar.bottom 按自然布局校准，钉扎却把布局按回锚位（+deltaY），两者相减
        // 恰好漏出 ~状态栏高的一条——标题/图标的下缘碎片恒驻沉浸态屏幕顶端。隐藏
        // 期间滑出交还 translationY 全权负责；退出还原分段（!isChromeHidden 且保持
        // 期内）照旧钉住，顶栏在窗口分段回落时逐帧不动（防「文件名跳动」）。
        if (p.view === topBar && isChromeHidden()) continue
        val t = (p.top + deltaY).coerceIn(0, height)
        val b = (p.bottom + deltaY).coerceIn(0, height)
        if (p.view.top != t || p.view.bottom != b) p.view.layout(p.view.left, t, p.view.right, b)
    }
}

/** 参与钉扎的 chrome：图片双 buffer + 顶栏 + 缩略图条 + 底部信息（幻灯片覆盖层除外）。 */
private fun NativeGalleryView.pinnedChromeChildren(): List<View> = listOf(primaryView, secondaryView, topBar, thumbnailStrip, bottomInfo)

/** 系统栏当前是否由本查看器隐藏（沉浸切换或幻灯片覆盖，二者都不改对方标志）。 */
private fun NativeGalleryView.isChromeHidden(): Boolean = isImmersive || slideshowHidSystemUi

/**
 * 主动测量并摆放抽屉子树（[updateDrawer] 的兜底）。
 * forceLayout 必须递归到每个后代：只标抽屉自己不够——中间层（ScrollView/容器/
 * GridLayout）的 specs 与上轮相同、又没有 FORCE_LAYOUT 时，会在各自那一层把
 * measure 跳掉，下探半路就停（实测 open.post 时格子仍 0x0）。
 */
internal fun NativeGalleryView.measureAndLayoutDrawerNow() {
    if (!isAttachedToWindow || width <= 0 || height <= 0) return
    forceLayoutRecursive(metadataDrawer)
    val lp = metadataDrawer.layoutParams
    // spec 取 layoutParams 的确定值（MATCH_PARENT 回退根尺寸）：两形制都从这里量出
    // 最终宽高——横屏宽=320dp/高=全高，竖屏宽=全宽/高=根高 2/3
    val wSpec = View.MeasureSpec.makeMeasureSpec(if (lp.width >= 0) lp.width else width, View.MeasureSpec.EXACTLY)
    val hSpec = View.MeasureSpec.makeMeasureSpec(if (lp.height >= 0) lp.height else height, View.MeasureSpec.EXACTLY)
    metadataDrawer.measure(wSpec, hSpec)
    if (isCompactPortrait) {
        // 竖屏：钉底——面板上缘 = 根高 − 面板高
        metadataDrawer.layout(0, height - metadataDrawer.measuredHeight, width, height)
    } else {
        metadataDrawer.layout(width - metadataDrawer.measuredWidth, 0, width, metadataDrawer.measuredHeight)
    }
}

private fun NativeGalleryView.forceLayoutRecursive(view: View) {
    view.forceLayout()
    if (view is ViewGroup) {
        for (i in 0 until view.childCount) {
            forceLayoutRecursive(view.getChildAt(i))
        }
    }
}
