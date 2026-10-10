package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp

// —— 自绘小图标（触屏端无 material-icons 依赖，与 TopBar/TreeSidebar 同一套画法）——

/** 返回箭头（‹）。 */
@Composable
internal fun BackArrowIcon(tint: Color) {
    Canvas(Modifier.size(22.dp)) {
        val s = size
        val w = s.width * 0.11f
        drawLine(
            tint,
            Offset(s.width * 0.62f, s.height * 0.18f),
            Offset(s.width * 0.32f, s.height * 0.5f),
            w,
            cap = StrokeCap.Round,
        )
        drawLine(
            tint,
            Offset(s.width * 0.32f, s.height * 0.5f),
            Offset(s.width * 0.62f, s.height * 0.82f),
            w,
            cap = StrokeCap.Round,
        )
    }
}

/** 右箭头（›），一级导航行尾用。 */
@Composable
internal fun ChevronIcon(tint: Color) {
    Canvas(Modifier.size(16.dp)) {
        val s = size
        val w = s.width * 0.13f
        drawLine(
            tint,
            Offset(s.width * 0.35f, s.height * 0.2f),
            Offset(s.width * 0.68f, s.height * 0.5f),
            w,
            cap = StrokeCap.Round,
        )
        drawLine(
            tint,
            Offset(s.width * 0.68f, s.height * 0.5f),
            Offset(s.width * 0.35f, s.height * 0.8f),
            w,
            cap = StrokeCap.Round,
        )
    }
}
