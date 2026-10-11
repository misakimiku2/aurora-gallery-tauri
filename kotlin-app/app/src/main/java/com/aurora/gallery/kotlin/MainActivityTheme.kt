package com.aurora.gallery.kotlin

import android.content.res.Configuration
import android.os.Build
import android.view.View
import android.widget.Toast
import androidx.core.view.WindowCompat
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.ui.isCompactWidth
import com.aurora.gallery.kotlin.ui.theme.AuroraPalettes

// 主题/系统栏簇（拆分清单第 28 刀，⑥ 第 3 刀）：M4c 主题管线（isDarkTheme / isSystemDark /
// applyWindowTheme 窗口底色与状态栏图标档）+ 查看器沉浸系统栏接管（setViewerImmersiveBars，
// B2-1「导航栏一律不碰」口径在 KDoc）+ 画布全屏开关（setViewerSystemBars）+ 关于页外链
// （openExternalUrl），6 个扩展函数落地（§5.1 手法，接收者 MainActivity，全 internal）。
// systemDark / showWelcome / viewerBarsHidden / savedSystemUiVisibility /
// savedViewerImmersiveUiVisibility 五个字段留原类（onConfigurationChanged / 欢迎向导 /
// requestPermission 回调等留守区仍读写），随本刀降 internal；viewModel 沿用第 26 刀。

/**
 * 查看器沉浸态的系统栏接管（2026-10-07 B2 定稿）：进=隐藏**状态栏** + 窗口色置黑，
 * 退=先还原主题色再 show 状态栏。
 *
 * **导航栏一律不碰**（B2-1，真机截图实测定音）：荣耀 MagicOS 的导航栏面板在
 * 「insets 隐藏→重新显示」这一轮之后会带系统默认底色（深 #2A2A2A / 浅白，无视
 * navigationBarColor）**常驻**盖住内容——`log/V2.jpg` 与 `log/V1.jpg` 逐像素对比：
 * 只有底部 64px（y=2276..2339）不同，V1 露的是图片、V2 是纯 #2A2A2A，其余全同。
 * 而导航栏在本 App 的常态下本是透明的（V1 底部就是图片本身），隐藏它换不来任何
 * 观感，只会换来这条色带 → 只 hide/show `Type.statusBars()`。同理不写
 * navigationBarColor：那条色带无视它，写了也只是徒增一个「重新显示」事件源。
 *
 * 退出时**先 [applyWindowTheme] 再 show**：调用顺序保证系统面板浮出时窗口底色已是
 * 主题色，接缝不可见。
 *
 * 位移风险不在 flags 层而在布局层：查看器容器已改成恒全屏（不吃 insets，见
 * setContent 组合根），翻转状态栏零 resize，图片不重居中。
 */
internal fun MainActivity.setViewerImmersiveBars(hidden: Boolean) {
    if (hidden == viewerBarsHidden) return
    viewerBarsHidden = hidden
    val window = this.window
    // ⚠ `android.view.WindowInsets.Type` 是 API 30 才有的类——它必须在下面的
    // 版本分支**内部**引用。提到外面（哪怕只是取个常量）在 API 29 上会直接
    // NoClassDefFoundError 崩进程（真机报障：荣耀 Magic2 一点图片就闪退）。
    if (hidden) {
        // 窗口底色置黑（沉浸时查看器铺满窗口，这层只在系统面板浮出时可见）；
        // 全限定名：本文件顶部已 import androidx.compose.ui.graphics.Color（重名）
        window.setBackgroundDrawable(
            android.graphics.drawable.ColorDrawable(android.graphics.Color.BLACK)
        )
        @Suppress("DEPRECATION")
        window.statusBarColor = android.graphics.Color.BLACK
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(android.view.WindowInsets.Type.statusBars())
                controller.systemBarsBehavior =
                    android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            if (savedViewerImmersiveUiVisibility == null) {
                @Suppress("DEPRECATION")
                savedViewerImmersiveUiVisibility = window.decorView.systemUiVisibility
            }
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN)
        }
    } else {
        // 先上主题色、后 show：让系统面板与查看器还原后的底色同色
        applyWindowTheme(isDarkTheme())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.show(android.view.WindowInsets.Type.statusBars())
                controller.systemBarsBehavior =
                    android.view.WindowInsetsController.BEHAVIOR_DEFAULT
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = savedViewerImmersiveUiVisibility
                ?: View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            savedViewerImmersiveUiVisibility = null
        }
    }
    android.util.Log.i("NativeViewer", "setViewerImmersiveBars hidden=$hidden api=${Build.VERSION.SDK_INT}")
}

internal fun MainActivity.setViewerSystemBars(hidden: Boolean) {
    val window = this.window
    if (hidden) {
        if (savedSystemUiVisibility == null) {
            @Suppress("DEPRECATION")
            savedSystemUiVisibility = window.decorView.systemUiVisibility
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(android.view.WindowInsets.Type.systemBars())
                controller.systemBarsBehavior =
                    android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION)
        }
    } else {
        // 全屏面关闭：系统栏整体还原（API<30 清 flags；R+ 显式 show + 行为位复位，
        // 残留 TRANSIENT_BY_SWIPE 会让主界面下滑只出瞬态栏，常态栏出不来）。
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = savedSystemUiVisibility ?: 0
        savedSystemUiVisibility = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.show(android.view.WindowInsets.Type.systemBars())
                controller.systemBarsBehavior =
                    android.view.WindowInsetsController.BEHAVIOR_DEFAULT
            }
        }
    }
    android.util.Log.i("NativeViewer", "setViewerSystemBars hidden=$hidden api=${Build.VERSION.SDK_INT}")
}

// —— M4c 主题管线 ——

/** settings.theme → 是否深色（M4c）。"system" 跟随 [systemDark]；组合内调用可触发重组。 */
internal fun MainActivity.isDarkTheme(): Boolean = when (viewModel.settings.value.theme) {
    AppSettings.THEME_DARK -> true
    AppSettings.THEME_LIGHT -> false
    else -> systemDark
}

internal fun MainActivity.isSystemDark(): Boolean =
    (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES

/**
 * 窗口层主题同步（M4c）：窗口底色 = palette.content——edge-to-edge 下系统栏镂空区露的
 * 也是这层；statusBarColor 在 API 35+ 被 edge-to-edge 忽略，低版本写它对齐观感。状态栏
 * 图标深浅随档切。SideEffect 每次重组幂等重写。2026-10-07 会话模型后色值全程归本函数
 * 管（系统栏接管只动 flags，不再写任何色值）。
 */
internal fun MainActivity.applyWindowTheme(dark: Boolean) {
    // 查看器沉浸期间窗口色归黑（[setViewerImmersiveBars]）：这条每次重组都会跑，
    // 不挡住会把黑底刷回主题色，瞬态系统栏一浮出就是一条亮边。还原分支显式重跑
    // 本函数（先置色、后 show），所以这里让位不会漏掉任何一次真正需要的重涂。
    if (viewerBarsHidden) return
    // 手机端欢迎向导：整卡铺满全屏，顶部品牌横幅（blue-600）直抵屏幕顶——状态栏
    // 镂空区刷横幅同色（浅深两档横幅同值，见 WelcomeFlow.BrandPanel），白图标。
    // 底部手势区不受影响：内容区 rightBg 背景本就画到屏幕底。平板向导是悬浮卡+
    // 页底色不吃这条；向导结束/转场后 SideEffect 重跑本函数自然还原主题色。
    if (showWelcome && isCompactWidth(resources.configuration)) {
        val brandBlue = 0xFF2563EB.toInt() // BrandPanel 同款 blue-600
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(brandBlue))
        @Suppress("DEPRECATION")
        window.statusBarColor = brandBlue
        WindowCompat.getInsetsController(window, window.decorView)
            ?.isAppearanceLightStatusBars = false
        return
    }
    val palette = AuroraPalettes.of(dark)
    // 窗口底色 = palette.main（2026-09-26 验收反馈：主界面悬浮卡片化对齐 React
    // 桌面 bg-main 环绕层）——App 的主界面 Row 内缩裁圆角成卡片，四周留边透出这层；
    // 状态栏/手势区背后也是它（API 35+ edge-to-edge 下 statusBarColor 被忽略，
    // 低版本写它对齐观感）。
    window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(palette.main))
    @Suppress("DEPRECATION")
    window.statusBarColor = palette.main
    // 导航栏也对齐 main（2026-10-07 真机报障）：EMUI 手势栏在常态下随窗口属性上色，
    // 默认值与周边底色不同（浅色=纯白、深色=#2A2A2A）。显式写 main 后栏色=四周
    // 环境色，网格与查看器底部手势区都隐形；API 35+ e2e 忽略此值，无副作用。
    @Suppress("DEPRECATION")
    window.navigationBarColor = palette.main
    WindowCompat.getInsetsController(window, window.decorView)
        ?.isAppearanceLightStatusBars = !dark
}

/** 关于页外链（GitHub/Issues，M4c）：系统浏览器打开；无浏览器等失败仅提示。 */
internal fun MainActivity.openExternalUrl(url: String) {
    runCatching {
        startActivity(
            android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)),
        )
    }.onFailure {
        Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show()
    }
}

