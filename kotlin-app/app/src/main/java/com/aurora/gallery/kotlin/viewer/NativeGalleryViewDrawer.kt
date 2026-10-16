package com.aurora.gallery.kotlin.viewer

// 抽屉装配簇（拆分清单第 22 刀）：顶栏/抽屉形制收敛、抽屉背景与把手拖拽、顶栏构建、
// 抽屉进度与开合动画，13 个扩展函数落地（§5.1 手法，接收者 NativeGalleryView）。
// 引用的视图字段/跨簇助手已在 NativeGalleryView 降 internal（33 处，正向穷举，
// 清单见第 22 刀提交说明）；animateDrawerTo 的 AnimatorListenerAdapter 按
// §7 第 8 条以 `val v = this` 捕获接收者。

import com.aurora.gallery.kotlin.R
import android.graphics.Color
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 按竖屏形制收敛/展开顶栏次级钮（幻灯片/旋转/图片信息）。删除键的显隐不在这里管：
 * 它要叠加 LAN 编辑门禁（updateTitle），两处各写一半会互相覆盖，归 updateTitle 一处。
 * 收敛用 View.GONE 而非不 addView：slideshowBtn/deleteBtn 是 lateinit 成员，
 * updateSlideshowButtonIcon、applyTheme 的 childCount 遍历、沉浸/抽屉动画都握着引用，
 * View.GONE 后 FrameLayout/LinearLayout 遍历 childCount 仍安全。
 */
internal fun NativeGalleryView.applyTopBarFormFactor() {
    if (!isTopBarBuilt()) return
    val collapsed = isCompactPortrait
    slideshowBtn.visibility = if (collapsed) View.GONE else View.VISIBLE
    screenRotateBtn.visibility = if (collapsed) View.GONE else View.VISIBLE
    infoBtn.visibility = if (collapsed) View.GONE else View.VISIBLE
}

/**
 * 抽屉背景唯一出处（M8b-8）。按形制给：
 * - 横屏/平板：左缘分隔线渐变（LEFT_RIGHT，border→panel），即原构建时写死的那个；
 * - 竖屏：panel 实色 + 顶部两角 16dp 圆角（底部直角贴屏幕边，用户拍板：不用渐变边）。
 * 把手条的着色也归这里（colorBorder 随主题），深浅色切换一并重涂。
 */
internal fun NativeGalleryView.applyDrawerBackground() {
    if (isCompactPortrait) {
        // 纯平直角面板（M8b-10 用户拍板：顶部圆角去掉）——面板全宽钉底，与顶部
        // 图片带平直衔接；单一 panel 实色，无描边无圆角
        metadataDrawer.background = android.graphics.drawable.GradientDrawable().apply {
            setColor(colorPanel())
        }
    } else {
        metadataDrawer.background = android.graphics.drawable.GradientDrawable().apply {
            orientation = android.graphics.drawable.GradientDrawable.Orientation.LEFT_RIGHT
            setColors(intArrayOf(colorBorder(), colorPanel()))
        }
    }
    drawerHandleView.background = android.graphics.drawable.GradientDrawable().apply {
        setColor(colorBorder())
        cornerRadius = resources.displayMetrics.density * 2
    }
}

/**
 * 按形制重设信息抽屉容器（M8b-8，用户拍板）：
 * - 手机竖屏（isCompactPortrait）：底部上滑面板——全宽 × 根高 2/3、gravity BOTTOM、
 *   顶部两角圆角、带拖拽把手条；抽屉是纯覆盖层，图片布局完全不动；
 * - 横屏手机/平板：右缘 320dp × 全高抽屉，原样（零回归）。
 *
 * 与 applyTopBarFormFactor 同款幂等思路，但除形制标志外还要比对 params：旋转后根高
 * 变了，竖屏 2/3 高度必须跟着重算（标志没变、尺寸变了）。根视图尚无尺寸时（首次
 * open() 时 View.GONE 未布局，height=0）挂起，onSizeChanged 拿到真实尺寸后补应用。
 * 调用点：onConfigurationChanged、open() 末尾、onSizeChanged；init 只上背景。
 */
internal fun NativeGalleryView.applyDrawerFormFactor() {
    val portrait = isCompactPortrait
    val drawerWidthPx = (resources.displayMetrics.density * 320).toInt()
    val lp = metadataDrawer.layoutParams
    // 幂等：形制一致且 params 已是目标值才短路（params 比对是旋转后 2/3 高重算的钩子）
    val paramsMatch = if (portrait) {
        height > 0 && lp.width == FrameLayout.LayoutParams.MATCH_PARENT && lp.height == height * 2 / 3
    } else {
        lp.width == drawerWidthPx && lp.height == FrameLayout.LayoutParams.MATCH_PARENT
    }
    if (drawerFormPortrait == portrait && paramsMatch && !drawerFormFactorPending) return
    if (portrait && height <= 0) {
        // 2/3 高度依赖根 View 实际高（不写死 dp），还没量出来就先挂起
        drawerFormFactorPending = true
        return
    }
    drawerFormFactorPending = false
    drawerFormPortrait = portrait
    if (portrait) {
        // 竖屏底部面板。图片带复位成「全高、fit 无裁切」基线（progress=0）——压缩与
        // fill 插值由 applyDrawerProgress 竖屏分支按进度重放（M8b-9 用户拍板的让位
        // 语义：面板打开时图片沾满顶部带，同平板图片让位左栏）。进度先于 layoutParams
        // 写（applyDrawerProgress 同款顺序约定：params 触发的下一轮布局里
        // resetToCenter 要读到归零后的 drawerFillProgress）
        primaryView.drawerFillProgress = 0f
        secondaryView.drawerFillProgress = 0f
        primaryView.drawerFullWidth = 0f
        secondaryView.drawerFullWidth = 0f
        primaryView.allowZoom = true
        secondaryView.allowZoom = true
        if (primaryView.layoutParams.width != FrameLayout.LayoutParams.MATCH_PARENT) {
            primaryView.layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            secondaryView.layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        }
        metadataDrawer.layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, height * 2 / 3).apply {
            gravity = android.view.Gravity.BOTTOM
        }
    } else {
        // 横屏/平板：右缘抽屉原样。图片压缩宽度不在这里写——抽屉开着时调用方会紧跟
        // applyDrawerProgress 按当前进度重放（含图片压缩），关着时本就该 MATCH_PARENT
        metadataDrawer.layoutParams = FrameLayout.LayoutParams(drawerWidthPx, FrameLayout.LayoutParams.MATCH_PARENT).apply {
            gravity = android.view.Gravity.END or android.view.Gravity.TOP
        }
    }
    applyDrawerBackground()
    // 把手拖拽条只属于底部面板形制（横屏右缘抽屉无下滑关闭语义）
    drawerHandleStrip.visibility = if (portrait) View.VISIBLE else View.GONE
    // 形制决定抽屉顶边是否在窗口顶（横屏全高抽屉要让状态栏），换形制即重算
    applyDrawerTopInset()
    // 位移落回「关闭」位：换了形制/尺寸，旧轴向位移值作废（横屏的 translationX=320
    // 在竖屏全宽面板下会露出一条竖条，反之面板整条悬在屏上）；抽屉开着时调用方
    //（onConfigurationChanged/onSizeChanged）会紧跟 applyDrawerProgress 按当前进度
    // 重放视觉——旋转中态直接落位，不要求动画过渡（用户拍板）
    parkDrawer()
}

/**
 * 抽屉归位（关闭位）——**按抽屉自己的实测尺寸**下移/右移，而不是再算一遍
 * `height*2/3`。
 *
 * 真机实锤（2026-10-07 B2-2，荣耀 Magic2 / API29）：要完全藏住必须
 * `translationY == 抽屉高`；而 `height*2/3` 是**按调用时刻的根高**算的，抽屉的
 * layoutParams 高度又是**另一个时刻**写的。进出沉浸时窗口内容帧在 [96,2340]（高
 * 2244）与 [0,2340]（高 2340）之间跳，两次各取一个根高 → 差 96px（状态栏高），
 * 露出 96×2/3 = **64px** 的面板顶边（#2A2A2A=palette.panel，逐行 std=0 的纯色带，
 * 盖住图片；抽屉把手在条下方 42..54px 处，正好被屏幕底边裁掉，所以看着是空条）。
 * 未进过沉浸时根高没变过 → 无错位 → 从不出现，与「只在这台机上、只有进出全屏后才有」
 * 完全吻合。改用自身尺寸后，无论何时调用都精确藏住，错位从机制上不可能。
 */
internal fun NativeGalleryView.parkDrawer() {
    if (isCompactPortrait) {
        metadataDrawer.translationX = 0f
        // 未布局时（height=0）退回按根高估算，避免写成 0 让面板整块露在屏上
        val h = metadataDrawer.height.takeIf { it > 0 } ?: drawerExtentPx
        metadataDrawer.translationY = h.toFloat()
    } else {
        metadataDrawer.translationY = 0f
        val w = metadataDrawer.width.takeIf { it > 0 } ?: drawerExtentPx
        metadataDrawer.translationX = w.toFloat()
    }
}

/**
 * 面板顶缘拖拽（M8b-9 用户拍板：从面板顶部——把手区——往下滑同样关闭）。跟手公式
 * 与图片区 onVerticalSwipeDrag 同式（下拖减进度=关、上拖加进度=开），方向限制取
 * 「只许向关闭方向」（条只在面板开着时摸得到），松手按位置过半或下甩速度吸附——
 * 与 onVerticalSwipeEnd 同阈值。条在 drawerScrollView 之前，拖它不会带动内容滚动。
 */
internal fun NativeGalleryView.setupHandleDrag() {
    var startY = 0f
    var startProgress = 0f
    var tracking = false
    var tracker: android.view.VelocityTracker? = null
    drawerHandleStrip.setOnTouchListener { _, event ->
        when (event.actionMasked) {
            android.view.MotionEvent.ACTION_DOWN -> {
                startY = event.rawY
                startProgress = drawerPanelProgress
                tracking = true
                tracker?.recycle()
                tracker = android.view.VelocityTracker.obtain()
                tracker?.addMovement(event)
                // 取消进行中的抽屉动画，跟手接管（onTouchDown 同款）
                drawerWidthAnimator?.cancel()
                drawerWidthAnimator = null
                true
            }
            android.view.MotionEvent.ACTION_MOVE -> {
                if (tracking) {
                    tracker?.addMovement(event)
                    val p = (startProgress - (event.rawY - startY) / drawerExtentPx)
                        .coerceIn(0f, startProgress)
                    applyDrawerProgress(p)
                }
                true
            }
            android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                if (tracking) {
                    tracker?.addMovement(event)
                    tracker?.computeCurrentVelocity(1000)
                    val p = (startProgress - (event.rawY - startY) / drawerExtentPx)
                        .coerceIn(0f, startProgress)
                    drawerOpen = !(p < 0.5f || (tracker?.yVelocity ?: 0f) > 500f)
                    animateDrawerTo(drawerOpen, fromProgress = p)
                    tracking = false
                }
                tracker?.recycle()
                tracker = null
                true
            }
            else -> false
        }
    }
}

internal fun NativeGalleryView.buildTopBar(): LinearLayout {
    val density = resources.displayMetrics.density
    return LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        // 行高 56dp 对齐图库顶条形制（2026-09-27 验收）。topMargin 只是初始值，真值
        // 由 [applyTopBarTopMargin] 按「状态栏让位量 + [TOP_BAR_TOP_GAP_DP]」每次
        // 布局同步——状态栏让位量取窗口 insets 并**扣掉容器自身顶偏移**（非 e2e 窗口
        // 容器顶本就在状态栏下方，自加就是双重内缩＝顶栏偏低）；也不读
        // status_bar_height 资源（被挖孔顶高，avd_honor29 实测 182 vs 实际 90）。
        layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, (density * 56).toInt()).apply {
            gravity = android.view.Gravity.TOP
            topMargin = (density * NativeGalleryView.TOP_BAR_TOP_GAP_DP).toInt()
        }
        setBackgroundColor(colorBgAlpha(0x4D))
        // 水平 16dp 对齐图库 TopBar 按钮起点（Row horizontal 8dp + 卡片边 8dp）；原 24px。
        setPadding((density * 16).toInt(), 0, (density * 16).toInt(), 0)
        gravity = android.view.Gravity.CENTER_VERTICAL

        // M8b 阶段 3（遗留 #2）：顶栏各键补中文 contentDescription（TalkBack 可读）。
        val closeBtn = makeIconButton(R.drawable.ic_lucide_arrow_left, contentDescription = "返回") { listener?.onClose() }
        titleView = TextView(context).apply {
            setTextColor(colorTextPrimary())
            textSize = 18f
            gravity = android.view.Gravity.CENTER_VERTICAL or android.view.Gravity.START
            layoutParams = LinearLayout.LayoutParams(0, FrameLayout.LayoutParams.MATCH_PARENT, 1f).apply {
                marginStart = (resources.displayMetrics.density * 4).toInt()
            }
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            setPadding(0, 0, (resources.displayMetrics.density * 8).toInt(), 0)
        }
        // M8b 阶段 3（遗留 #2）：播放钮只服务幻灯片（视频支持 D47 拍板不做），语义
        // 定为「幻灯片播放」而非「播放」；播/停两态的图标与描述由
        // updateSlideshowButtonIcon 随播放态同步。
        slideshowBtn = makeIconButton(R.drawable.ic_lucide_play, contentDescription = "幻灯片播放") { toggleSlideshow() }
        // 「旋转图片」→「旋转屏幕」（2026-10-07 用户拍板）：按当前方向翻转（竖进横、
        // 横进竖），退出/再点还原；图标沿用 rotate_cw（资源库暂无手机横置类图标），
        // 语义由描述/菜单文案承载——描述随钉屏态在 updateScreenRotateButtonIcon 同步
        //（updateSlideshowButtonIcon 先例）。
        screenRotateBtn = makeIconButton(R.drawable.ic_lucide_rotate_cw, contentDescription = "横屏查看") { toggleScreenOrientation() }
        infoBtn = makeIconButton(R.drawable.ic_lucide_info, contentDescription = "图片信息") { toggleDrawer() }
        deleteBtn = makeIconButton(R.drawable.ic_lucide_trash, tintColor = colorDanger(), contentDescription = "删除") { showDeleteConfirmDialog() }
        val shareBtn = makeIconButton(R.drawable.ic_lucide_share, contentDescription = "分享") { shareCurrentImage() }
        moreBtn = makeIconButton(R.drawable.ic_lucide_more_vertical, contentDescription = "更多") { showMoreMenu(moreBtn) }

        addView(closeBtn)
        addView(titleView)
        addView(slideshowBtn)
        addView(screenRotateBtn)
        addView(infoBtn)
        addView(deleteBtn)
        addView(shareBtn)
        addView(moreBtn)
        // 竖屏手机 7 钮+标题挤爆（标题缩成 m5...png，2026-09-27 验收）：按形制收敛
        // 次级钮，只留 返回|标题|分享|更多；被收动作在「更多」菜单头部补位（showMoreMenu）。
        applyTopBarFormFactor()
    }
}

internal fun NativeGalleryView.makeImageButton(text: String, onClick: () -> Unit): TextView {
    val density = resources.displayMetrics.density
    val pad = (density * 14).toInt()
    return TextView(context).apply {
        this.text = text
        setTextColor(colorTextPrimary())
        textSize = 24f
        setPadding(pad, pad, pad, pad)
        layoutParams = LinearLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT)
        setOnClickListener { onClick() }
    }
}

/**
 * 顶栏图标按钮构造器。M8b 阶段 3（遗留 #2）：补可选 [contentDescription]——纯图标
 * ImageView 没有文本，此前 TalkBack 只能读出空白，无障碍不可用。默认 null 保持
 * 旧调用行为不变，顶栏各键的中文描述由 buildTopBar 调用处显式给出。
 */
internal fun NativeGalleryView.makeIconButton(
    drawableRes: Int,
    tintColor: Int = colorTextPrimary(),
    contentDescription: String? = null,
    onClick: () -> Unit,
): ImageView {
    val density = resources.displayMetrics.density
    // 2026-09-27 验收（触控目标）：固定 48×48dp 命中盒（移动端硬规范下限；原
    // wrap_content+10dp padding = 44dp 视觉=44dp 触控，不达标）。14dp 内边距下
    // ImageView 默认 FIT_CENTER 把 24dp lucide 图标缩到 48−2×14=20dp 视觉——与
    // 图库 TopBarButton 的 20dp 图标 + 48dp 命中盒完全同带。
    val pad = (density * 14).toInt()
    return ImageView(context).apply {
        setImageResource(drawableRes)
        setColorFilter(tintColor)
        setPadding(pad, pad, pad, pad)
        layoutParams = LinearLayout.LayoutParams((density * 48).toInt(), (density * 48).toInt())
        // M8b 阶段 3（遗留 #2）：无障碍语义；null 时维持旧行为（无描述）
        this.contentDescription = contentDescription
        setOnClickListener { onClick() }
    }
}

internal fun NativeGalleryView.buildSectionTitle(title: String, weight: Float = 0f, iconRes: Int? = null): TextView {
    val density = resources.displayMetrics.density
    return TextView(context).apply {
        text = title
        setTextColor(colorTextSecondary())
        textSize = 11f
        paint.isFakeBoldText = true
        if (iconRes != null) {
            val drawable = context.getDrawable(iconRes)
            drawable?.setTint(colorTextSecondary())
            val iconSize = (density * 12).toInt()
            drawable?.setBounds(0, 0, iconSize, iconSize)
            setCompoundDrawablesRelative(drawable, null, null, null)
            compoundDrawablePadding = (density * 6).toInt()
        }
        setPadding(0, (density * 16).toInt(), 0, (density * 8).toInt())
        layoutParams = LinearLayout.LayoutParams(0, FrameLayout.LayoutParams.WRAP_CONTENT, weight).apply {
            if (weight == 0f) width = FrameLayout.LayoutParams.MATCH_PARENT
        }
    }
}

internal fun NativeGalleryView.makeTextButton(text: String, onClick: () -> Unit): TextView {
    return TextView(context).apply {
        this.text = text
        setTextColor(colorAccent())
        textSize = 12f
        setPadding((resources.displayMetrics.density * 12).toInt(), (resources.displayMetrics.density * 8).toInt(), 0, (resources.displayMetrics.density * 8).toInt())
        setOnClickListener { onClick() }
    }
}

/**
 * 根据 progress（0=关闭, 1=打开）应用抽屉视觉状态。
 * progress 驱动：抽屉位移（轴向/行程随形制，见 [drawerExtentPx]）、图片宽度、填充缩放、
 * topBar/缩略图条/底部信息同步隐藏（全屏样式）。
 *
 * M8b-8 方向化：横屏抽屉与图片分栏（抽屉挤占图片宽度）；竖屏底部面板是纯覆盖层，
 * 图片完全不动（用户拍板）——imageW 压缩、drawerFillProgress、drawerFullWidth、
 * layoutParams 写回、allowZoom 锁全部只走横屏分支，竖屏只位移面板。图片渲染消费的
 * drawerFillProgress 竖屏恒 0：面板开着时双击缩放/换图 resetToCenter 仍按 fit 走；
 * 面板自身进度权威值记 [drawerPanelProgress]（两种形制都写）。
 */
internal fun NativeGalleryView.applyDrawerProgress(progress: Float) {
    drawerPanelProgress = progress
    // 视频 P3-A2：抽屉一离开全关位就让位并暂停——两种形制都会压缩图片区（横屏挤宽、竖屏
    // 挤高）并把封面切成填充裁切，而视频层按信箱适配，两套几何口径对不上；且竖屏面板
    // 正压在播控条那一条上。回到 0 由本函数同一入口交还
    videoLayer.setDrawerOccluded(progress > 0.01f)
    val extent = drawerExtentPx
    val totalWidth = width.toFloat()
    if (!isCompactPortrait) {
        // 横屏：抽屉从右缘滑入 + 图片宽度压缩（分栏）
        val imageW = (totalWidth - progress * extent).toInt().coerceAtLeast(0)
        // 抽屉位移
        metadataDrawer.translationX = (1f - progress) * extent
        metadataDrawer.translationY = 0f
        // 图片宽度 + 填充进度（在 layoutParams 之前设置，确保 onSizeChanged→resetToCenter 读到最新值）
        primaryView.drawerFillProgress = progress
        secondaryView.drawerFillProgress = progress
        // 抽屉展开时禁止图片缩放（双击/双指），避免缩放与 drawerFillProgress 填充逻辑冲突；
        // 视频动态位同样禁缩（缩的是视频底下那张封面，见 applyVideoZoomLock）
        val allowZoom = progress <= 0.01f && !videoLayer.isStarted
        primaryView.allowZoom = allowZoom
        secondaryView.allowZoom = allowZoom
        // 设置全屏宽度基准，供 resetToCenter 计算 fitS（固定），避免 vw 减小时 fitS 先降后升
        primaryView.drawerFullWidth = totalWidth
        secondaryView.drawerFullWidth = totalWidth
        primaryView.layoutParams = FrameLayout.LayoutParams(imageW, FrameLayout.LayoutParams.MATCH_PARENT)
        secondaryView.layoutParams = FrameLayout.LayoutParams(imageW, FrameLayout.LayoutParams.MATCH_PARENT)
    } else {
        // 竖屏：底部面板从屏幕底外上滑；图片带高度同步压缩到面板让出的顶部——
        // M8b-9 用户拍板的让位语义（平板=图片沾满左栏、竖屏=沾满顶部带）。
        // drawerFillProgress 驱动 fit→fill 插值：开满时图片填满顶部带（宽贴满、
        // 上下居中裁切）；进度先于 params 写，onSizeChanged→resetToCenter 读到
        // 最新值（横屏分支同款顺序约定）。drawerFullWidth 竖屏不写（宽度恒定，
        // fitVw=vw，vh 收缩使 fitS 单调下降无「先降后升」）
        val imageH = (height - progress * extent).toInt().coerceAtLeast(0)
        metadataDrawer.translationY = (1f - progress) * extent
        metadataDrawer.translationX = 0f
        primaryView.drawerFillProgress = progress
        secondaryView.drawerFillProgress = progress
        // 抽屉展开时禁止图片缩放（双击/双指），避免缩放与抽屉填充
        // 逻辑冲突（横屏同款）；视频动态位一并锁（见 applyVideoZoomLock）
        val allowZoom = progress <= 0.01f && !videoLayer.isStarted
        primaryView.allowZoom = allowZoom
        secondaryView.allowZoom = allowZoom
        primaryView.layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, imageH)
        secondaryView.layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, imageH)
    }
    // topBar 向上滑出（沉浸模式下始终保持隐藏，不受抽屉进度影响）。滑出量一律含
    // 容器顶的窗口偏移（=状态栏高度）：B1 后系统栏常驻，只滑 -bottom 会停在状态
    // 栏区内露出按钮（M8b-8「滑一个身位≠移出屏幕」同源教训，横竖屏统一走窗口坐标）。
    if (topBar.height > 0) {
        topBar.translationY = topBarHideTranslation(if (isImmersive) 1f else progress)
    }
    // 缩略图条向下滑出（沉浸模式下始终保持隐藏）
    if (thumbnailStrip.height > 0) {
        thumbnailStrip.translationY = if (isImmersive) height.toFloat() else thumbnailStrip.height.toFloat() * progress
    }
    // 底部信息向下滑出（沉浸模式下始终保持隐藏）
    if (bottomInfo.visibility == View.VISIBLE && bottomInfo.height > 0) {
        bottomInfo.translationY = if (isImmersive) height.toFloat() else bottomInfo.height.toFloat() * progress
    }
}

/**
 * 动画抽屉到目标状态。[open] 目标状态，[fromProgress] 起始进度（用于跟手松手后从当前位置动画）。
 * 行程用 [drawerExtentPx]（竖屏=面板高 2/3 根高、横屏=320dp）。竖屏底部面板结束时不
 * 联动系统状态栏、不动背景色、不消费 immersiveBeforeDrawer（用户拍板：纯覆盖层、
 * 底部面板不需要隐藏状态栏，保持简单）；横屏保持原逻辑。
 */
internal fun NativeGalleryView.animateDrawerTo(open: Boolean, fromProgress: Float) {
    val v = this
    val targetProgress = if (open) 1f else 0f
    val portrait = isCompactPortrait
    val extent = drawerExtentPx
    val totalWidth = width.toFloat()
    val duration = 280L

    drawerWidthAnimator?.cancel()
    val animator = android.animation.ValueAnimator.ofFloat(fromProgress, targetProgress)
    drawerWidthAnimator = animator
    animator.duration = duration
    animator.interpolator = AccelerateDecelerateInterpolator()
    animator.addUpdateListener { anim ->
        applyDrawerProgress(anim.animatedValue as Float)
    }
    var cancelled = false
    animator.addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationCancel(animation: android.animation.Animator) {
            cancelled = true
        }
        override fun onAnimationEnd(animation: android.animation.Animator) {
            v.drawerWidthAnimator = null
            if (cancelled) return
            // 精确设置最终状态
            v.applyDrawerProgress(targetProgress)
            if (portrait) {
                // 竖屏：底部面板纯覆盖层——不隐藏系统状态栏、背景色不动
                return
            }
            val finalW = if (open) (totalWidth - extent).toInt().coerceAtLeast(0) else FrameLayout.LayoutParams.MATCH_PARENT
            v.primaryView.layoutParams = FrameLayout.LayoutParams(finalW, FrameLayout.LayoutParams.MATCH_PARENT)
            v.secondaryView.layoutParams = FrameLayout.LayoutParams(finalW, FrameLayout.LayoutParams.MATCH_PARENT)
            if (open) {
                // 抽屉打开：系统栏本就随会话隐藏（2026-10-07 模型），无需也不可再切换
                // （不改 isImmersive，保留单次点击的沉浸状态）
            } else {
                // 抽屉关闭：恢复抽屉打开前的沉浸状态。横屏抽屉打开期间不改
                // isImmersive，也没动过背景与系统栏，这里只需把它落回权威值
                v.isImmersive = v.immersiveBeforeDrawer
                v.setBackgroundColor(if (v.immersiveBeforeDrawer) Color.BLACK else v.colorBg())
            }
        }
    })
    animator.start()
}

internal fun NativeGalleryView.toggleDrawer() {
    if (!drawerOpen) {
        // 即将打开抽屉——保存当前沉浸状态，关闭时恢复
        immersiveBeforeDrawer = isImmersive
    }
    drawerOpen = !drawerOpen
    // 动画起点读面板进度权威值（M8b-8）：横屏与 drawerFillProgress 同步；竖屏
    // drawerFillProgress 恒 0，读它会让「开着再关」的动画从关闭位跳变
    val currentProgress = drawerPanelProgress
    animateDrawerTo(drawerOpen, fromProgress = currentProgress)
}
