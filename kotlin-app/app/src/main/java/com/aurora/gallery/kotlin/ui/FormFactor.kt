package com.aurora.gallery.kotlin.ui

import android.content.res.Configuration

/**
 * 形态判据共享（M8b 1.1：此前 TopBar/FileGrid/FoldersOverview/SettingsDialog/
 * CanvasAddImagesDialog 五处内联 `screenWidthDp < 600` 收敛于此，判据只许有一套）。
 *
 * 两档语义：
 *  - [isCompactWidth]：窄宽档（<600dp）= 竖屏手机。间距分档（FileGrid/FoldersOverview）、
 *    TopBar 44dp 紧凑按钮与「更多」菜单合并、对话框窄屏收窄等「宽度驱动的紧凑化」都用它。
 *    横屏手机（宽 ≥600dp）不在内——沿用现状拿平板档参数，本判据不改变任何既有分档值。
 *  - [isTabletForm]：平板形态（宽 ≥600dp 且高 ≥480dp，M5 D28 定义）——画布门控、设置
 *    双栏对话框断点。M8b 起（D45）抽屉/推挤的宿主分叉同以它为界：!isTablet（竖屏手机 +
 *    横屏手机）走平移抽屉，平板路径零改动。
 */
fun isCompactWidth(configuration: Configuration): Boolean = configuration.screenWidthDp < 600

fun isTabletForm(configuration: Configuration): Boolean =
    configuration.screenWidthDp >= 600 && configuration.screenHeightDp >= 480
