package com.aurora.gallery.kotlin.viewer

// 进出过渡与加载簇（拆分清单第 25 刀）：过渡挂起期的 chrome 压透明/揭幕淡入对，
// 大图数据源与 Coil 加载链（缩略图先行 + 迟到回调作废守卫 + 邻接预加载），
// 6 个扩展函数落地（§5.1 手法，接收者 NativeGalleryView）。
// open/close/navigate/revealAfterTransition/hideForTransition/destroy 是
// MainActivity 跨包调用的公开 API，留原类（同第 24 刀 handleRotation 取舍）。
// 引用的 imageLoader/loadGeneration/progressBar/companion TAG 已在
// NativeGalleryView 降 internal（4 处，双向穷举，清单见第 25 刀提交说明）；
// imageSourceFor/coilSource/CoilSource 是同包顶层（ImageSource.kt），免 import。
// 继承作用域裸标识符限定：VISIBLE/GONE -> View.x；TAG -> NativeGalleryView.TAG
// （companion 成员在扩展里必须限定名，§7 第 15 条 ②）。

import android.util.Log
import android.view.View
import android.widget.Toast
import coil.request.ImageRequest
import coil.size.Precision

/** 参与揭幕淡入的 chrome（图片本体不淡：它已经和覆盖层逐位对齐了）。 */
internal fun NativeGalleryView.transitionChrome(): List<View> = listOf(topBar, thumbnailStrip, bottomInfo)

/** 过渡挂起期把 chrome 压成全透明，揭幕时淡回；非挂起路径恒复位成 1（防上次残留）。 */
internal fun NativeGalleryView.applyTransitionChrome(held: Boolean) {
    val a = if (held) 0f else 1f
    for (v in transitionChrome()) v.alpha = a
}

/**
 * 大图数据源（D8 A 案）。本地 `content://` 一律由宿主开流喂给 Coil，
 * 不让 URI 进解码器——理由见 [imageSourceFor]。
 */
internal fun NativeGalleryView.coilSourceOf(item: NativeGalleryView.ImageItem, variant: String = "full"): CoilSource =
    imageSourceFor(item, context.contentResolver, variant)

internal fun NativeGalleryView.loadCurrent(animateIn: Boolean) {
    loadIntoView(activeView, currentIndex)
    syncVideoLayer()
    preloadNeighbors()
}

internal fun NativeGalleryView.loadIntoView(view: ZoomableImageView, index: Int, rotation: Int = rotationDegrees, showProgress: Boolean = true) {
    val item = images.getOrNull(index) ?: return
    if (showProgress) progressBar.visibility = View.VISIBLE
    Log.i(NativeGalleryView.TAG, "loadIntoView: index=$index, name=${item.name}, isLan=${item.isLan}, path=${item.path}, thumbUrl=${item.thumbnailUrl}")

    // 本轮请求代号：写进视图，迟到的过期回调（上一张图的缩略图/高清图）据此作废
    val generation = ++loadGeneration
    view.boundLoadGeneration = generation
    view.isFullResShown = false

    // 先加载缩略图（如果有），再加载原图
    val thumbUrl = item.thumbnailUrl
    val videoCoverOnly = item.isVideo
    if (!thumbUrl.isNullOrEmpty()) {
        val thumbRequest = ImageRequest.Builder(context)
            .data(thumbUrl)
            // lambda target + 守卫，不再用 .target(view)（ImageViewTarget 会绕过守卫
            // 直接上屏）：预加载已把高清图送进内存缓存时，高清图先到、缩略图后到，
            // 迟到的缩略图会把已显示的高清图覆盖回低清——就是「切页后永远停在缩略图」
            .target(
                onSuccess = { drawable ->
                    if (view.boundLoadGeneration != generation) {
                        Log.i(NativeGalleryView.TAG, "discard stale thumbnail: index=$index name=${item.name}")
                        return@target
                    }
                    if (view.isFullResShown) {
                        Log.i(NativeGalleryView.TAG, "skip late thumbnail: index=$index name=${item.name}")
                        return@target
                    }
                    view.setImageDrawable(drawable)
                    if (videoCoverOnly) {
                        // 视频项的封面就是它在「静态位」上的最终画面（动态位归视频层），
                        // 本轮请求到此为止：进度条没有别的成功回调可以等它了
                        view.isFullResShown = true
                        if (showProgress) progressBar.visibility = View.GONE
                    }
                },
                // 视频项的封面是它唯一的静态位来源：取不到也得把进度条收掉，
                // 否则这一页只剩一个永远转不完的圈（大图请求已明确不发）
                onError = {
                    if (videoCoverOnly && view.boundLoadGeneration == generation && showProgress) {
                        Log.e(NativeGalleryView.TAG, "video cover failed: index=$index name=${item.name}")
                        progressBar.visibility = View.GONE
                    }
                },
            )
            .precision(Precision.INEXACT)
            .build()
        imageLoader.enqueue(thumbRequest)
    }

    if (videoCoverOnly) {
        // 视频 P3-A2：大图请求**不发**。mp4 进 Coil 两头都是坑——解码必失败（表现成一句
        // Failed to load 的 Toast），且 HttpUri fetcher 会把整只文件拉进磁盘缓存（LAN 录屏
        // 上百 MB）。A1/A3/A4 那几轮就是靠这条注定失败的请求「看起来无害」混过去的。
        if (showProgress && thumbUrl.isNullOrEmpty()) progressBar.visibility = View.GONE
        // 换页动画进行中不做同步：那会让新一页的播放键在旧页还在滑出时就亮在屏幕正中
        if (index == currentIndex && !isAnimating.get()) syncVideoLayer()
        return
    }

    val request = coilSource(ImageRequest.Builder(context), coilSourceOf(item))
        .target(
            onSuccess = { drawable ->
                if (view.boundLoadGeneration != generation) {
                    Log.i(NativeGalleryView.TAG, "discard stale full: index=$index name=${item.name} (view now on gen ${view.boundLoadGeneration})")
                    return@target
                }
                view.isFullResShown = true
                if (showProgress) progressBar.visibility = View.GONE
                Log.i(NativeGalleryView.TAG, "full ready: index=$index name=${item.name} ${drawable.intrinsicWidth}x${drawable.intrinsicHeight}")
                view.setImageDrawable(drawable)
                view.setRotationDegrees(rotation)
            },
            onError = { _ ->
                if (view.boundLoadGeneration != generation) {
                    Log.i(NativeGalleryView.TAG, "discard stale full error: index=$index name=${item.name}")
                    return@target
                }
                if (showProgress) progressBar.visibility = View.GONE
                // 失败原因由 Coil 的 logger 以堆栈形式打出（见 imageLoader 的 .logger(...)）：
                // 这个 target 重载拿不到 throwable，只记「加载失败」在真机上等于查不了
                Log.e(NativeGalleryView.TAG, "failed to load index=$index name=${item.name} path=${item.path}")
                Toast.makeText(context, "Failed to load ${item.name}", Toast.LENGTH_SHORT).show()
            }
        )
        .precision(Precision.INEXACT)
        .build()
    imageLoader.enqueue(request)
}

internal fun NativeGalleryView.preloadNeighbors() {
    // 预加载当前 ±1 张到 memory cache
    for (offset in intArrayOf(1, -1, 2, -2)) {
        val idx = currentIndex + offset
        if (idx < 0 || idx >= images.size) continue
        val item = images[idx]
        // 视频项跳过：这里的请求形制与大图请求相同（喂的是原图 URL），预加载等于提前
        // 把整只 mp4 拉进缓存。视频的「邻接预热」只该预热封面，而封面走 thumbnailUrl，
        // 由翻页那一刻的 loadIntoView 现取（LAN 的封面是服务端缓存帧，本就快）
        if (item.isVideo) continue
        val request = coilSource(ImageRequest.Builder(context), coilSourceOf(item))
            .precision(Precision.INEXACT)
            .build()
        imageLoader.enqueue(request)
    }
}
