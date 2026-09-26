package com.aurora.gallery.kotlin.viewer

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.aurora.gallery.kotlin.LanMetadataItem
import com.aurora.gallery.kotlin.state.AppState
import org.json.JSONObject
import uniffi.aurora_core.FfiFileMetadata
import uniffi.aurora_core.Image

/**
 * 查看器层的挂载入口：放在 Activity 组合根的顶层、主内容之后（Compose 里后声明的画在上层），
 * 于是网格切到「扫描中」重载分支时查看器不会被拆掉——React 版的 overlay 本来也在 WebView
 * 之外，这条语义是平移过来的，不是新发明的。
 *
 * 宿主形态见 [NativeViewerLayer]（D7）。
 */
@Composable
fun ViewerLayerHost(
    state: AppState,
    /** **网格的展示序列**（过滤+排序后），不是全库序列——2.2 的硬要求。 */
    displayImages: List<Image>,
    viewerProvider: () -> NativeGalleryView,
    /** 抽屉「位置」一行显示的上级文件夹名；BROWSER 视图下即当前文件夹名。 */
    parentName: String = "",
    /** 抽屉要显示的标签与元数据，来自 `GalleryViewModel` 的标签快照（M4a 2.2）。 */
    tagsByFile: Map<String, List<String>> = emptyMap(),
    metadataById: Map<String, FfiFileMetadata> = emptyMap(),
    /**
     * 远端元数据缓存（M6a 阶段 5）：远端 path → [LanMetadataItem]（GalleryViewModel
     * 的 lanMetaByPath）。isLan 项的抽屉标签/描述/来源只取这里（[toViewerItem] 的显式
     * isLan 分支），绝不回读上面两份本地快照。
     */
    lanMetaById: Map<String, LanMetadataItem> = emptyMap(),
    /**
     * LAN 大图 URL 构造器（M6a 阶段 4）：远端 path → imageUrl；未连接为 null。
     * 宿主从 LanManager.currentSession 现取——查看器序列在打开时拷走 URL，断线后
     * 退出 LAN 视图由宿主的联动兜住。
     */
    lanImageUrlOf: ((String) -> String)? = null,
    /**
     * LAN 编辑门禁位（M6a 阶段 6，allow_edit）：直通时查看器才给 LAN 项提供删除入口
     * （顶栏删除键 + 「更多」菜单项）。与 [lanImageUrlOf] 同款会话现取——门禁位随每次
     * 目录 browse 尾随同步，宿主读 mutableState 的最新值传入。
     */
    lanAllowEdit: Boolean = false,
    /**
     * file_id → 主色调 hex 列表（M6b 阶段 3）：[GalleryViewModel.colorPalettesById] 快照，
     * 本地项抽屉 Section 4 的预填源（LAN 项恒空，[toViewerItem] 内分支）。remember key
     * 之一——提取成功增量写入后重组，但 `open()` 不重跑，打开中的查看器靠宿主
     * `updateItem` 单项回填。
     */
    colorPalettesById: Map<String, List<String>> = emptyMap(),
    /**
     * 浏览时自动提取主色调开关（M6b 阶段 3）：随组合推进查看器实例（lanAllowEdit 同款
     * 先例），抽屉的 loading/按钮显示态由查看器现读。
     */
    autoExtractPalette: Boolean = false,
) {
    val fileId = state.activeTab.viewingFileId ?: return
    val viewer = remember { viewerProvider() }
    val items = remember(displayImages, parentName, tagsByFile, metadataById, lanMetaById, lanImageUrlOf, colorPalettesById) {
        displayImages.map { img ->
            // 显式 isLan 分支：远端项的元数据只喂 lanMetaById（fileId=远端 path），本地
            // 快照两参一律不传——不是靠「key 不撞」的运气，是结构上就不读（D31 铁律）。
            if (img.contentUri.startsWith("http")) {
                img.toViewerItem(parentName, emptyList(), null, lanMetaById[img.id], lanImageUrlOf)
            } else {
                img.toViewerItem(
                    parentName,
                    tagsByFile[img.id].orEmpty(),
                    metadataById[img.id],
                    null,
                    lanImageUrlOf,
                    colorPalettesById[img.id].orEmpty(),
                )
            }
        }
    }
    val startIndex = displayImages.indexOfFirst { it.id == fileId }.coerceAtLeast(0)
    NativeViewerLayer(
        viewer = viewer,
        items = items,
        startIndex = startIndex,
        lanAllowEdit = lanAllowEdit,
        autoExtractPalette = autoExtractPalette,
        onRequestClose = { state.closeViewer() },
    )
}

/**
 * 查看器宿主（D7 定案 = Compose 全屏条件层 + `AndroidView` 承载）。
 *
 * 只在有图在看时进入组合；[viewer] 实例由 Activity 持有、在其生命周期内复用——Coil 的
 * 内存/磁盘缓存跟着实例走，随进出组合重建会把缓存整体丢掉（4.2 压测要盯的内存台阶正来自这里）。
 *
 * `open()` 只在**进入组合时**跑一次：后台重扫会让 [items] 换一份，若把它作为
 * `LaunchedEffect` 的键，用户刚删掉一张图就会触发重新 open、被拉回进入的那一张
 * （3.2 的验收要的正是「删完停在下一张」）。序列在打开时已拷进查看器自己的列表。
 */
@Composable
fun NativeViewerLayer(
    viewer: NativeGalleryView,
    items: List<NativeGalleryView.ImageItem>,
    startIndex: Int,
    /** LAN 编辑门禁位（M6a 阶段 6）：同步到查看器实例，删除入口的显隐在现读时生效。 */
    lanAllowEdit: Boolean = false,
    /** 浏览时自动提取主色调开关（M6b 阶段 3）：抽屉 loading/按钮态由查看器现读。 */
    autoExtractPalette: Boolean = false,
    onRequestClose: () -> Unit,
) {
    AndroidView(
        factory = { viewer },
        modifier = Modifier.fillMaxSize(),
    )
    val latestItems by rememberUpdatedState(items)
    val latestStart by rememberUpdatedState(startIndex)
    val latestClose by rememberUpdatedState(onRequestClose)
    // 门禁位推进查看器实例（key = 值本身：浏览中门禁变化也即时生效，菜单构建时现读）
    LaunchedEffect(lanAllowEdit) { viewer.lanAllowEdit = lanAllowEdit }
    LaunchedEffect(autoExtractPalette) { viewer.autoExtractPalette = autoExtractPalette }
    LaunchedEffect(Unit) { viewer.open(latestItems, latestStart, viewerOptions) }
    // 查看器自己实现了 dispatchKeyEvent（幻灯片 → 抽屉 → 关闭），拿到焦点时由它逐层消化；
    // 这条 BackHandler 是拿不到焦点时的兜底，兜底也要走同一把梯子，否则会一次 back 关掉整个查看器。
    BackHandler {
        when {
            viewer.isSlideshowPlaying() -> viewer.exitSlideshow()
            viewer.isDrawerOpen() -> viewer.closeDrawer()
            else -> latestClose()
        }
    }
}

/**
 * `open()` 的 options。isDark 由 MainActivity 的 SideEffect 按 settings.theme 推导后经
 * [applyViewerTheme] 写入——查看器在每次 open 时读取，与 Compose 侧 `AuroraTheme(darkTheme=)`
 * 同一个值。M8b 阶段 3（遗留 #5）销账：已打开状态下由同一 SideEffect 直呼
 * [NativeGalleryView.applyThemeNow] 即时重涂，不再有「收掉重开才换色」的边界。
 */
private val viewerOptions = JSONObject().put("isDark", false)

/** 主题档落定后同步查看器 options（M4c；下一次 open 生效）。 */
internal fun applyViewerTheme(dark: Boolean) {
    viewerOptions.put("isDark", dark)
}
