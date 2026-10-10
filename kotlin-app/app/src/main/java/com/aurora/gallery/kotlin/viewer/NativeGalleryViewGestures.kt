package com.aurora.gallery.kotlin.viewer

// 手势与翻图簇（拆分清单第 23 刀）：ZoomableImageView 手势监听装配与滑动翻页全链路
// （邻接图准备 / 切换 / 回弹 / 即时清理、硬件层开关、有效宽度），7 个扩展函数落地
// （§5.1 手法，接收者 NativeGalleryView）。
// 引用的状态字段/跨簇助手已在 NativeGalleryView 降 internal（21 处，双向穷举，
// 清单见第 23 刀提交说明）；SWIPE_THRESHOLD_DP / SWIPE_VELOCITY_THRESHOLD 两个
// 常量仅本簇消费，随簇落成 top-level private；SWIPE_INTERPOLATOR 还被原类
// 进出过渡区消费，留 companion 降 internal。
// setupZoomableListeners 的 OnSwipeOutListener 是 object 表达式，按 §7 第 8 条
// 以 `val v = this` 捕获接收者（lambda 才继承隐式接收者，object 不继承）。

import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.View
import kotlin.math.abs

/** 翻页触发距离阈值（dp），固定值不受横竖屏影响 */
private const val SWIPE_THRESHOLD_DP = 32f

/** 翻页触发速度阈值 */
private const val SWIPE_VELOCITY_THRESHOLD = 200f

internal fun NativeGalleryView.setupZoomableListeners(view: ZoomableImageView) {
    val v = this
    view.swipeOutListener = object : ZoomableImageView.OnSwipeOutListener {
        override fun onSwipeOut(direction: Int, dx: Float) {}
        override fun onSwipeDrag(dx: Float) {
            if (v.isAnimating.get()) return
            if (dx == 0f) return
            val actView = v.activeView
            actView.translationX = dx
            val dir = if (dx > 0) -1 else 1
            val adjacentIndex = v.currentIndex + dir
            if (adjacentIndex < 0 || adjacentIndex >= v.images.size) return
            if (!v.swipeAdjacentPrepared || v.swipeAdjacentDirection != dir) {
                v.prepareSwipeAdjacent(dir)
            }
            val adj = v.swipeCachedAdjacentView
            if (adj != null && v.swipeAdjacentPrepared && v.swipeAdjacentDirection == dir) {
                adj.translationX = dx + dir * v.swipeCachedWidth
            }
        }
        override fun onSwipeEnd(dx: Float, velocityX: Float) {
            if (v.isAnimating.get()) return
            val threshold = v.resources.displayMetrics.density * SWIPE_THRESHOLD_DP
            val shouldNavigate = abs(dx) > threshold || (abs(velocityX) > SWIPE_VELOCITY_THRESHOLD && abs(dx) > v.touchSlopForSwipe)
            val dir = if (dx > 0) -1 else 1
            // 切换成功路径不放触觉反馈（M8b-11 用户报真机每切一张震一下）：翻页是
            // 高频手势，系统相册类应用也不在切换处振动；模拟器无振动马达复现不了，
            // 代码路径两端一致。长按的 LONG_PRESS 触觉保留（低频手势确认，见
            // onLongPressConfirmed）。React 版移植时就带这声振动（M3 284d90113），
            // 模拟器验收从未暴露。
            if (shouldNavigate && dx != 0f) {
                val adjacentIndex = v.currentIndex + dir
                if (v.swipeAdjacentPrepared && v.swipeAdjacentDirection == dir && adjacentIndex in 0 until v.images.size) {
                    v.navigateFromSwipe(dir)
                } else if (adjacentIndex in 0 until v.images.size) {
                    v.cleanupSwipeAdjacentImmediate()
                    v.navigate(dir)
                } else {
                    v.bounceBackSwipe(dir)
                }
            } else {
                if (v.swipeAdjacentPrepared) {
                    v.bounceBackSwipe(dir)
                } else {
                    v.activeView.animate()
                        .translationX(0f)
                        .setDuration(250)
                        .setInterpolator(NativeGalleryView.SWIPE_INTERPOLATOR)
                        .withEndAction { v.setSwipeHardwareLayers(false) }
                        .start()
                }
            }
        }
        override fun onTouchDown() {
            if (v.isAnimating.get()) return
            val actView = v.activeView
            actView.animate().cancel()
            actView.translationX = 0f
            v.cleanupSwipeAdjacentImmediate()
            // 取消正在进行的抽屉动画，跟手接管——取消后必须按权威进度回写
            // drawerOpen：松手判定（onVerticalSwipeEnd/把手拖拽/toggleDrawer）先把
            // drawerOpen 置为目标值再起 280ms 动画，动画若在这里被下一次触摸取消，
            // onAnimationEnd 因 cancelled 早退、面板停在取消时刻的 progress，标志与
            // 视觉就此脱钩（面板视觉已关而 drawerOpen 恒 true），此后所有单击被
            // onSingleTapConfirmed/toggleImmersive 的 drawerOpen 护栏静默吞掉——
            // 真机「点击图片不进全屏且零反应」的根因（2026-10-06 荣耀/华为报障）
            v.drawerWidthAnimator?.cancel()
            v.drawerWidthAnimator = null
            v.drawerOpen = v.drawerPanelProgress > 0.5f
            // 记录抽屉跟手起始状态，供 onVerticalSwipeDrag/End 使用。
            // 进度读 drawerPanelProgress（面板进度权威值）：竖屏 drawerFillProgress
            // 恒 0，读它会让松手后的继续拖动被方向限制钳在 0 跟丢手指
            v.drawerDragStartOpen = v.drawerOpen
            v.drawerDragStartProgress = v.drawerPanelProgress
            if (!v.drawerOpen) {
                // 可能即将通过垂直手势打开抽屉——保存沉浸状态
                v.immersiveBeforeDrawer = v.isImmersive
            }
        }
        override fun onSingleTapConfirmed() {
            Log.i("NativeViewer", "onSingleTapConfirmed: drawerOpen=${v.drawerOpen} isImmersive=${v.isImmersive} isOpen=${v.isOpen}")
            if (v.drawerOpen) return
            // 幻灯片播放时本视图被 SlideshowView 覆盖，不会收到此回调
            v.toggleImmersive()
        }
        override fun onVerticalSwipeDrag(dy: Float) {
            if (v.isAnimating.get()) return
            // 行程随形制（M8b-8）：横屏=320dp（右缘抽屉），竖屏=根高 2/3（底部面板）。
            // 轴向虽不同，progress 语义一致：上滑（dy<0）→ progress 增大 → 抽屉打开，
            // 下滑（dy>0）→ 关闭——竖屏面板从屏底外上滑，方向天然成立
            var progress = (v.drawerDragStartProgress - dy / v.drawerExtentPx).coerceIn(0f, 1f)
            // 方向限制：抽屉打开时只允许向关闭方向（progress 减小），
            // 抽屉关闭时只允许向打开方向（progress 增大），反向滑动无效果
            if (v.drawerDragStartOpen) {
                progress = progress.coerceAtMost(v.drawerDragStartProgress)
            } else {
                progress = progress.coerceAtLeast(v.drawerDragStartProgress)
            }
            v.applyDrawerProgress(progress)
        }
        override fun onVerticalSwipeEnd(dy: Float, velocityY: Float) {
            if (v.isAnimating.get()) return
            var currentProgress = (v.drawerDragStartProgress - dy / v.drawerExtentPx).coerceIn(0f, 1f)
            // 应用与 drag 相同的方向限制
            if (v.drawerDragStartOpen) {
                currentProgress = currentProgress.coerceAtMost(v.drawerDragStartProgress)
            } else {
                currentProgress = currentProgress.coerceAtLeast(v.drawerDragStartProgress)
            }
            // 判断目标状态：根据当前进度和速度
            val targetOpen = if (v.drawerDragStartOpen) {
                !(currentProgress < 0.5f || velocityY > 500f)
            } else {
                currentProgress > 0.5f || velocityY < -500f
            }
            v.drawerOpen = targetOpen
            v.animateDrawerTo(targetOpen, fromProgress = currentProgress)
        }
        override fun onLongPressConfirmed() {
            // M4b 6.1 收口：长按仅保留触感反馈——查看器的全部操作已在「⋮」菜单
            // 承载（删除/重命名/复制到/移动到/幻灯片），无独立的上下文菜单需求
            //（桌面查看器也无长按菜单同位项）。
            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        }
    }
}

/** 滑动期间启用/禁用硬件层，将视图渲染缓存为 GPU 纹理，使 translationX 变为纯纹理位移。 */
private fun NativeGalleryView.setSwipeHardwareLayers(enabled: Boolean) {
    val layerType = if (enabled) View.LAYER_TYPE_HARDWARE else View.LAYER_TYPE_NONE
    primaryView.setLayerType(layerType, null)
    secondaryView.setLayerType(layerType, null)
}

/**
 * 返回当前图片视图的实际宽度。抽屉打开时 primaryView/secondaryView 宽度被压缩，
 * 翻页滑动需基于压缩后的宽度计算邻接图位置，否则图片会滑出错误的距离。
 * 视图未测量时回退到 NativeGalleryView 自身宽度。
 */
internal fun NativeGalleryView.effectiveViewWidth(): Float {
    val pw = primaryView.width
    return if (pw > 0) pw.toFloat() else width.toFloat()
}

private fun NativeGalleryView.prepareSwipeAdjacent(dir: Int) {
    val adjacentIndex = currentIndex + dir
    if (adjacentIndex < 0 || adjacentIndex >= images.size) return
    val cw = effectiveViewWidth()
    val span = cw + swipeGapPx
    val adj = adjacentView()
    adj.animate().cancel()
    loadIntoView(adj, adjacentIndex, rotation = 0, showProgress = false)
    adj.translationX = dir * span
    adj.visibility = View.VISIBLE
    swipeAdjacentPrepared = true
    swipeAdjacentDirection = dir
    swipeCachedWidth = span
    swipeCachedAdjacentView = adj
    setSwipeHardwareLayers(true)
}

private fun NativeGalleryView.navigateFromSwipe(direction: Int) {
    val newIndex = currentIndex + direction
    if (newIndex < 0 || newIndex >= images.size) {
        bounceBackSwipe(direction)
        return
    }
    currentIndex = newIndex
    rotationDegrees = 0
    // 切换图片时清除主色调 loading 状态（与 navigateTo 一致）
    loadingPaletteFileId = null

    isAnimating.set(true)
    val outgoing = activeView
    val incoming = adjacentView()
    activeView = incoming

    val cw = effectiveViewWidth() + swipeGapPx
    val duration = 280L
    outgoing.animate()
        .translationX(-direction * cw)
        .setDuration(duration)
        .setInterpolator(NativeGalleryView.SWIPE_INTERPOLATOR)
        .withEndAction {
            outgoing.translationX = 0f
            outgoing.visibility = View.GONE
            outgoing.setImageDrawable(null)
        }
        .start()
    incoming.animate()
        .translationX(0f)
        .setDuration(duration)
        .setInterpolator(NativeGalleryView.SWIPE_INTERPOLATOR)
        .withEndAction {
            isAnimating.set(false)
            swipeAdjacentPrepared = false
            swipeAdjacentDirection = 0
            swipeCachedAdjacentView = null
            swipeCachedWidth = 0f
            setSwipeHardwareLayers(false)
            listener?.onNavigate(currentIndex)
            preloadNeighbors()
            thumbnailAdapter.highlight(currentIndex)
        }
        .start()

    updateTitle()
}

private fun NativeGalleryView.bounceBackSwipe(dir: Int) {
    val cw = swipeCachedWidth
    val duration = 280L
    activeView.animate()
        .translationX(0f)
        .setDuration(duration)
        .setInterpolator(NativeGalleryView.SWIPE_INTERPOLATOR)
        .withEndAction {
            setSwipeHardwareLayers(false)
        }
        .start()
    if (swipeAdjacentPrepared) {
        val adj = swipeCachedAdjacentView ?: adjacentView()
        adj.animate()
            .translationX(dir * cw)
            .setDuration(duration)
            .setInterpolator(NativeGalleryView.SWIPE_INTERPOLATOR)
            .withEndAction {
                adj.translationX = 0f
                adj.visibility = View.GONE
                adj.setImageDrawable(null)
                swipeAdjacentPrepared = false
                swipeAdjacentDirection = 0
                swipeCachedAdjacentView = null
                swipeCachedWidth = 0f
            }
            .start()
    }
}

internal fun NativeGalleryView.cleanupSwipeAdjacentImmediate() {
    if (swipeAdjacentPrepared) {
        val adj = swipeCachedAdjacentView ?: adjacentView()
        adj.animate().cancel()
        adj.translationX = 0f
        adj.visibility = View.GONE
        adj.setImageDrawable(null)
        swipeAdjacentPrepared = false
        swipeAdjacentDirection = 0
    }
    swipeCachedAdjacentView = null
    swipeCachedWidth = 0f
    setSwipeHardwareLayers(false)
}
