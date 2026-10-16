package com.aurora.gallery.kotlin.viewer

// 视频 P3-A2：查看器与视频层之间的胶水簇——绑定同步、翻页避让（滑动位移镜像 / 离场动画
// 跟随 / 换页静音）、色表重涂。视图本体见 [VideoLayerView]，装配与生命周期在
// NativeGalleryView，手势侧消费点在 NativeGalleryViewGestures。

import android.view.View

/** 当前这一张是视频才返回它（图片项一律 null，调用方据此走原图片路径）。 */
internal fun NativeGalleryView.videoItem(): NativeGalleryView.ImageItem? =
    images.getOrNull(currentIndex)?.takeIf { it.isVideo }

/**
 * 把视频层同步到「当前这一张」：图片项一律 detach（绝不把上一路的出声带进这一页），
 * 视频项只做 bind（记 URL、显中央播放键，**不预拉数据**）。
 *
 * 调用时机 = 所有会让 `currentIndex` 落定的路径：[NativeGalleryView.loadCurrent]、
 * 两种翻页的动画收尾、[NativeGalleryView.open] 的重放分支。
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
 * 动态位（已起播）时锁掉图片视图的双击/双指缩放：缩的是视频底下那张封面，画面不动、
 * 几何先坏，松掉播放键才会露出错位。抽屉那条 allowZoom 判据同源（见 applyDrawerProgress）。
 */
internal fun NativeGalleryView.applyVideoZoomLock() {
    val allow = !videoLayer.isStarted && drawerPanelProgress <= 0.01f
    primaryView.allowZoom = allow
    secondaryView.allowZoom = allow
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
}
