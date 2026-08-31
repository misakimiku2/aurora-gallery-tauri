package com.aurora.gallery.kotlin

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 网格缩略图单元（M1 阶段 1.3），两段式「先糊后清」：
 *  1. `loadFast` 立即上屏（高清缓存命中即高清，否则 MINI_KIND 可能偏小）；
 *  2. 若偏小/缺失，后台 `generateHd` 用 Rust 生成 256px 高清后无缝替换。
 * 全程 IO 线程异步执行，不阻塞滚动；未命中前显示占位符。
 */
@Composable
fun MediaThumbnail(
    contentUri: String,
    contentDescription: String?,
    loader: ThumbnailLoader,
    modifier: Modifier = Modifier,
) {
    val imageId = remember(contentUri) { loader.extractImageId(contentUri) }

    val bitmap by produceState<Bitmap?>(initialValue = null, imageId) {
        // 1) 快速上屏
        val fast = withContext(Dispatchers.IO) { loader.loadFast(imageId) }
        value = fast

        // 2) 偏小/缺失时后台升级为高清
        if (fast == null || loader.needsUpgrade(fast)) {
            val hd = withContext(Dispatchers.IO) { loader.generateHd(imageId, contentUri) }
            if (hd != null) value = hd
        }
    }

    val bmp = bitmap
    if (bmp != null) {
        Image(
            bitmap = bmp.asImageBitmap(),
            contentDescription = contentDescription,
            contentScale = ContentScale.Crop,
            modifier = modifier,
        )
    } else {
        Box(
            modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) {
            Text("…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
