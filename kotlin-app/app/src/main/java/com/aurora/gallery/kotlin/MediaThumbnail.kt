package com.aurora.gallery.kotlin

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 网格缩略图单元（M1 阶段 1.3），两段式「先糊后清」：
 *  1. `loadFast` 立即上屏（高清磁盘缓存命中即高清，否则 loadThumbnail 系统缩略图）；
 *  2. 偏小/缺失时后台 `generateHd` 用 Rust 生成 256px 高清后无缝替换。
 *
 * 性能要点：
 *  - 内存缓存命中时同步取初始值，item 回收重进不闪烁、不重复解码；
 *  - `asImageBitmap` 用 `remember` 缓存，避免每次重组重建包装对象；
 *  - 缩略图由「进入文件夹后台预生成」逐步写入磁盘缓存，滚动中命中磁盘缓存（快），
 *    未命中才回退 loadThumbnail，故无需滚动中暂停加载。
 */
@Composable
fun MediaThumbnail(
    contentUri: String,
    contentDescription: String?,
    loader: ThumbnailLoader,
    modifier: Modifier = Modifier,
) {
    val imageId = remember(contentUri) { loader.extractImageId(contentUri) }
    // 同步取内存缓存作初始值，命中时首帧即为成品，避免 null → bitmap 的闪烁
    val cached = remember(imageId) { loader.peekMemory(imageId) }
    val bitmap = remember(imageId) { mutableStateOf(cached) }

    // 1) 快速上屏（仅当内存缓存未命中）
    LaunchedEffect(imageId) {
        if (bitmap.value != null) return@LaunchedEffect
        val fast = loader.loadFastLimited(imageId)
        bitmap.value = fast
    }

    // 2) 偏小/缺失时后台升级高清（预生成未覆盖时的兜底）
    LaunchedEffect(imageId, bitmap.value) {
        val bmp = bitmap.value ?: return@LaunchedEffect
        if (!loader.needsUpgrade(bmp)) return@LaunchedEffect
        val hd = withContext(Dispatchers.IO) { loader.generateHd(imageId, contentUri) }
        if (hd != null) bitmap.value = hd
    }

    val bmp = bitmap.value
    // 缓存 asImageBitmap，避免每次重组重建 ImageBitmap 包装对象
    val imageBitmap: ImageBitmap? = remember(bmp) { bmp?.asImageBitmap() }
    if (imageBitmap != null) {
        Image(
            bitmap = imageBitmap,
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
