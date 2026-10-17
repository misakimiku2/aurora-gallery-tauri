package com.aurora.gallery.kotlin.viewer

// 视频 P3-A2/A2.5：查看器与视频层之间的胶水簇——绑定同步、翻页避让（滑动位移镜像 /
// 离场动画跟随 / 换页静音）、顶栏随播控条一起显隐、色表重涂。视图本体见 [VideoLayerView]，
// 装配与生命周期在 NativeGalleryView，手势侧消费点在 NativeGalleryViewGestures。

import android.view.View

/** 当前这一张是视频才返回它（图片项一律 null，调用方据此走原图片路径）。 */
internal fun NativeGalleryView.videoItem(): NativeGalleryView.ImageItem? =
    images.getOrNull(currentIndex)?.takeIf { it.isVideo }

/**
 * 把视频层同步到「当前这一张」：图片项一律 detach（绝不把上一路的出声带进这一页），
 * 视频项只做 bind（记 URL、显封面与播控条，**不预拉数据**）。
 *
 * 调用时机 = 所有会让 `currentIndex` 落定的路径：[NativeGalleryView.loadCurrent]、
 * 两种翻页的动画收尾、删除/移出后的重放。
 */
internal fun NativeGalleryView.syncVideoLayer() {
    val item = videoItem()
    if (item == null) {
        videoLayer.detach()
        return
    }
    videoLayer.bind(item.fileId, item.path, item.durationMs, item.width, item.height)
}

/**
 * 翻页起步先静音：滑动的 280ms 里画面还在原处，但声音不该继续铺到下一张上。
 * 上一路的彻底停掉在收尾 [syncVideoLayer] 换 bind 时完成（那里是唯一的当前项出口）。
 */
internal fun NativeGalleryView.silenceVideoForPageSwitch() {
    videoLayer.pauseForBackground()
}

/**
 * 视频层浮在两张图之上，翻页时它不属于「双 buffer 交换」那套机制——不跟着走就会出现
 * 「封面已滑出、画面还钉在原地」。这里让它复刻离场那张的位移。
 *
 * 收尾**不做 detach**：新当前项由翻页动画的 end action 调 [syncVideoLayer]，那里
 * `bind(fileId 不同)` 内部就会停掉上一路。两处各拆一次反而要争先后顺序。
 */
internal fun NativeGalleryView.slideVideoLayerOutWith(outgoing: View, targetTranslationX: Float, duration: Long) {
    if (!videoLayer.isBound) return
    videoLayer.animate().cancel()
    videoLayer.translationX = outgoing.translationX
    videoLayer.animate()
        .translationX(targetTranslationX)
        .setDuration(duration)
        .setInterpolator(NativeGalleryView.SWIPE_INTERPOLATOR)
        .withEndAction { videoLayer.translationX = 0f }
        .start()
}

/** 回弹路径：位移与离场那张一起回到原位（没有 detach，视频留在原页继续可用）。 */
internal fun NativeGalleryView.slideVideoLayerBack(duration: Long) {
    if (!videoLayer.isBound) return
    videoLayer.animate().cancel()
    videoLayer.animate()
        .translationX(0f)
        .setDuration(duration)
        .setInterpolator(NativeGalleryView.SWIPE_INTERPOLATOR)
        .start()
}

/**
 * 顶栏跟着播控条一起收起/唤回（A2.5 拍板：起播静置 2 秒两条一起滑出，单击画面唤回）。
 *
 * 只借 [topBarHideTranslation] 那套既有滑出量，不碰 isImmersive——沉浸态是图片查看器的
 * 语义（真全屏 + 系统栏接管），视频这条只是把 chrome 藏起来，系统栏归宿主管。
 * 抽屉开着时不接管顶栏：那条 translationY 归 [applyDrawerProgress] 权威。
 */
internal fun NativeGalleryView.setVideoChromeHidden(hidden: Boolean) {
    if (topBar.height <= 0) return
    if (drawerOpen || drawerPanelProgress > 0.01f) return
    topBar.animate().cancel()
    val target = if (hidden) topBarHideTranslation() else if (isImmersive) topBarHideTranslation() else 0f
    if (topBar.translationY != target) topBar.translationY = target
}

/**
 * 循环钮（顶栏，仅视频项出现）：状态回写给按钮着色。
 * 循环位存在播放器上，`stop()` 不清它，所以换页/重开都保持用户上一次的选择。
 */
internal fun NativeGalleryView.toggleVideoLoop() {
    val looping = videoLayer.toggleLoop()
    if (isTopBarBuilt()) {
        loopBtn.setColorFilter(if (looping) colorAccent() else colorTextPrimary())
    }
}

/**
 * 视频层重涂：信箱底=本类当前背景色值（沉浸态那个是纯黑，与 [NativeGalleryView.applyTheme]
 * 的分支同源），文字/图标=主文字色，播控条底=背景加不透明度（与底部信息栏同一档）。
 */
internal fun NativeGalleryView.applyVideoPalette() {
    videoLayer.applyPalette(
        bgColor = if (isImmersive) android.graphics.Color.BLACK else colorBg(),
        textColor = colorTextPrimary(),
        panelColor = colorBgAlpha(0xE6),
        accentColor = colorAccent(),
    )
    // 循环钮的着色跟着主题走（开着循环=主色，关着=主文字色）
    if (isTopBarBuilt()) {
        loopBtn.setColorFilter(if (videoLayer.isLooping) colorAccent() else colorTextPrimary())
    }
}
