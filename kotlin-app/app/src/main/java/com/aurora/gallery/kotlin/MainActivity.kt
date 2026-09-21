package com.aurora.gallery.kotlin

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.aurora.gallery.kotlin.ui.components.FileGrid
import com.aurora.gallery.kotlin.ui.components.CreateTopicDialog
import com.aurora.gallery.kotlin.ui.components.PeopleOverview
import com.aurora.gallery.kotlin.ui.components.SelectionBar
import com.aurora.gallery.kotlin.ui.components.SelectionMoreAction
import com.aurora.gallery.kotlin.ui.components.TagsOverview
import com.aurora.gallery.kotlin.ui.components.TopicChildrenSection
import com.aurora.gallery.kotlin.ui.components.TopicsOverview
import com.aurora.gallery.kotlin.ui.components.TopicPickerDialog
import com.aurora.gallery.kotlin.ui.components.SidebarPane
import com.aurora.gallery.kotlin.ui.components.TopBar
import com.aurora.gallery.kotlin.ui.components.TreeSidebar
import com.aurora.gallery.kotlin.ui.components.filterFolders
import com.aurora.gallery.kotlin.ui.components.rememberDisplayImages
import com.aurora.gallery.kotlin.ui.components.sortFolders
import com.aurora.gallery.kotlin.ui.components.FoldersOverview
import com.aurora.gallery.kotlin.ui.components.PinchGridSpanListener
import com.aurora.gallery.kotlin.ui.components.PullToRefreshIndicator
import com.aurora.gallery.kotlin.ui.components.PullToRefreshState
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import android.view.View
import com.aurora.gallery.kotlin.viewer.NativeGalleryView
import com.aurora.gallery.kotlin.viewer.ViewerLayerHost
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.ViewMode
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import uniffi.aurora_core.TagGroup
import org.json.JSONException
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    /**
     * 数据与 UI 状态都住在 GalleryViewModel（跨旋转重建保留）。factory 只在 ViewModel
     * 首次创建时求值，这里的横竖屏判断即初始面板可见性，旋转后不会被重算覆盖。
     */
    private val viewModel: GalleryViewModel by viewModels {
        GalleryViewModel.factory(
            application,
            LayoutVisibility(
                isSidebarVisible =
                    resources.configuration.orientation != Configuration.ORIENTATION_PORTRAIT,
            ),
        )
    }

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) viewModel.startScanIfNeeded()
    }

    /**
     * 4.2 删除：MediaStore.createDeleteRequest 的系统确认弹窗结果。用户允许后 MediaStore
     * 变更经 ContentObserver 自动重扫对账（GalleryViewModel.mediaStoreObserver），这里只
     * 负责退出编辑模式（对齐 React 确认后 handleExitAndroidSelectionMode 的时点）。
     */
    private val deleteLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            viewModel.appState.exitSelectionMode()
        }
    }

    // —— M3 查看器（D7：Compose 条件层承载，实例由本 Activity 持有）——

    /**
     * 查看器实例跟 Activity 走、不跟组合走：它的 Coil ImageLoader 挂着 30% 内存缓存与
     * 200MB 磁盘缓存，`destroy()` 会把它 shutdown，所以每次进出查看器重建实例等于每次
     * 清空缓存（4.2 要盯的内存台阶正来自这种重建）。
     */
    private var viewer: NativeGalleryView? = null

    private fun ensureViewer(): NativeGalleryView = viewer ?: NativeGalleryView(this).also {
        it.listener = viewerListener(it)
        viewer = it
    }

    private fun viewerListener(view: NativeGalleryView) = object : NativeGalleryView.Listener {
        override fun onClose() {
            view.close()
            viewModel.appState.closeViewer()
        }

        /**
         * 3.3：翻页跟到当前这张。不回写的话转屏重建 Activity 后会回到「进入时那张」，
         * 而不是用户正在看的那张。
         */
        override fun onNavigate(index: Int) {
            view.fileIdAt(index)?.let { viewModel.appState.viewerNavigated(it) }
        }

        /** 3.3：沉浸是纯系统 UI 控制，M3 就做。 */
        override fun onImmersiveToggle(immersive: Boolean) = setImmersiveMode(immersive)

        /**
         * 3.2 删除：查看器自己已经把这张从它的序列里摘掉并前进到下一张（confirmDelete），
         * 宿主只负责发起真正的删除请求。确认弹窗是查看器内的 `DeleteConfirmDialog`
         * （与网格 4.2 的应用内确认同一形态），不走 [onDeleteSelection] 那条网格链路。
         * 删完的索引对账交给既有 ContentObserver 重扫。
         */
        override fun onDelete(fileId: String) {
            viewModel.resolveSelectionUris(setOf(fileId)) { uris -> requestDelete(uris) }
        }

        /** 3.2 分享：单图版，复用网格那套 ACTION_SEND_MULTIPLE。 */
        override fun onShare(filePath: String) {
            if (filePath.isEmpty()) {
                toastSoon("分享", "M4")
                return
            }
            shareUris(listOf(Uri.parse(filePath)))
        }

        /** 3.3：幻灯片配置查看器已就地生效（能播、能设间隔），M3 没有设置持久层可写。 */
        override fun onUpdateSlideshowConfig(configJson: String) {
            Log.i("AuroraViewer", "slideshow config applied: $configJson")
        }

        // —— 以下入口的能力属 M4/M6，M3 只保证「点下去有确定反应」——
        override fun onMore(fileId: String) = toastSoon("更多操作", "M4")
        override fun onLongPress(fileId: String) = toastSoon("长按上下文菜单", "M4")
        override fun onEditTags(fileId: String) = toastSoon("标签保存", "M4")

        /**
         * M4a 2.1：查看器三个编辑弹窗的落库分支。键与语义见
         * [NativeGalleryView.Listener.onUpdateFile] 的契约注释。
         *
         * 本方法是「查看器协议 → 数据层」的唯一适配点：解析在这里做，落库与快照重算在
         * [GalleryViewModel.saveFileUpdates]，元数据面板（4.2）直接调后者、不经过这里。
         */
        override fun onUpdateFile(fileId: String, updatesJson: String) {
            val updates = try {
                JSONObject(updatesJson)
            } catch (e: JSONException) {
                Log.w("AuroraKotlin", "[Edit] updatesJson 解析失败: $updatesJson", e)
                Toast.makeText(this@MainActivity, "保存失败", Toast.LENGTH_SHORT).show()
                return
            }
            val tags = updates.optJSONArray("tags")?.let { arr ->
                // getString 而非 optString：契约里 tags 恒为字符串数组（见 Listener 注释），
                // 元素类型不对时宁可让这次保存炸在日志里，也不静默丢掉一个标签。
                List(arr.length()) { arr.getString(it) }
            }
            val description = if (updates.has("description")) updates.getString("description") else null
            val sourceUrl = if (updates.has("sourceUrl")) updates.getString("sourceUrl") else null
            if (tags == null && description == null && sourceUrl == null) {
                // 走到这里的实际只有 `{"name": …}`（查看器的重命名弹窗）。文件重命名改的是
                // MediaStore 的 DISPLAY_NAME、不是元数据行，本地库侧归 M4b。
                toastSoon("重命名", "M4b")
                return
            }
            viewModel.saveFileUpdates(fileId, tags, description, sourceUrl) { ok ->
                if (!ok) Toast.makeText(this@MainActivity, "保存失败", Toast.LENGTH_SHORT).show()
            }
        }

        override fun onColorSearch(colorHex: String) = toastSoon("按颜色搜索", "M4")
        override fun onExtractPalette(fileId: String, filePath: String) = toastSoon("主色调提取", "M6")
        override fun onCopyToFolder(fileId: String) = toastSoon("复制到文件夹", "M4")
        override fun onMoveToFolder(fileId: String) = toastSoon("移动到文件夹", "M4")
        override fun onFolderPickerConfirm(fileId: String, targetFolderId: String, type: String) =
            toastSoon("文件夹选择", "M4")
    }

    /** 未落地能力的可见占位（M3 3.3：静默无响应在真机上会被当成 bug 报回来）。 */
    private fun toastSoon(feature: String, milestone: String) {
        Toast.makeText(this, "$feature 将随 $milestone 提供", Toast.LENGTH_SHORT).show()
    }

    /**
     * 3.3 沉浸：从 React 壳 `setImmersiveMode` 平移（那边是 overlay 的窗口标志，这里是
     * Activity 窗口——D7 ③ 下查看器就在 Activity 的视图树里，系统栏控制天然归到窗口层）。
     * 首次进入前记下状态栏原色，退出时还原。
     */
    private var savedStatusBarColor: Int? = null

    private fun setImmersiveMode(immersive: Boolean) {
        val window = this.window
        if (immersive) {
            if (savedStatusBarColor == null) savedStatusBarColor = window.statusBarColor
            WindowCompat.setDecorFitsSystemWindows(window, false)
        } else {
            WindowCompat.setDecorFitsSystemWindows(window, true)
            savedStatusBarColor?.let { window.statusBarColor = it }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                if (immersive) {
                    controller.hide(android.view.WindowInsets.Type.systemBars())
                    controller.systemBarsBehavior =
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    controller.show(android.view.WindowInsets.Type.systemBars())
                }
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (immersive) {
                @Suppress("DEPRECATION")
                (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
            } else {
                @Suppress("DEPRECATION")
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            }
        }
        if (immersive) window.statusBarColor = android.graphics.Color.TRANSPARENT
    }

    override fun onDestroy() {
        viewer?.destroy()
        viewer = null
        super.onDestroy()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            // 必须与窗口 XML 主题（Theme.AuroraKotlin = Material.Light，固定浅色）一致：
            // 跟随系统深色会拿到深色调色板（textPrimary=#E5E5E5），把浅灰文件名画在白底上看不清。
            AuroraTheme(darkTheme = false) {
                val appState = viewModel.appState
                val tab = appState.activeTab
                // 当前该显示哪批图（文件夹 / 标签命中 / 专题成员）：导航与标签筛选都收敛到
                // 这一个触发点。协程随 key 变化自动取消，所以「点进 B 还没查完」不会把 A
                // 的结果盖上去——旧 openFolder 里手写的竞态守卫由结构化并发兜住了。
                LaunchedEffect(tab.viewMode, tab.folderId, tab.activeTags, tab.activeTopicId) {
                    viewModel.reloadImages()
                }
                // 展示序列在这一层求值，网格与查看器共用同一个结果（2.2：进入的 startIndex
                // 必须落在过滤后的序列上，两处各算一遍会有漂移风险）
                val displayImages = rememberDisplayImages(
                    viewModel.images.value,
                    appState.activeTab,
                    appState.sortBy,
                    appState.sortDirection,
                )
                val currentFolderName = appState.activeTab.folderId?.let { id ->
                    viewModel.folders.value.firstOrNull { it.id == id }?.name
                }.orEmpty()
                Box(Modifier.fillMaxSize()) {
                    App(
                        state = appState,
                        folders = viewModel.folders.value,
                        images = viewModel.images.value,
                        displayImages = displayImages,
                        tagGroups = viewModel.tagGroups.value,
                        topics = viewModel.topics.value,
                        coverImagesById = viewModel.coverImagesById.value,
                        scanning = viewModel.scanning.value,
                        thumbnailLoader = viewModel.thumbnailLoader,
                        onFolderClick = { viewModel.openFolder(it) },
                        onTopicClick = { viewModel.appState.openTopic(it.id) },
                        onCreateTopic = { name, parentId -> viewModel.createTopic(name, parentId) },
                        onAddToTopic = { topicId, ids ->
                            viewModel.addFilesToTopic(topicId, ids) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已加入专题" else "加入专题失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                if (ok) viewModel.appState.exitSelectionMode()
                            }
                        },
                        onRemoveFromTopic = { topicId, ids ->
                            viewModel.removeFilesFromTopic(topicId, ids) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已从专题移除" else "移除失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                if (ok) viewModel.appState.exitSelectionMode()
                            }
                        },
                        onShareSelection = { ids ->
                            viewModel.resolveSelectionUris(ids) { uris ->
                                if (uris.isNotEmpty()) shareUris(uris)
                            }
                        },
                        onDeleteSelection = { ids ->
                            viewModel.resolveSelectionUris(ids) { uris ->
                                if (uris.isNotEmpty()) requestDelete(uris)
                            }
                        },
                        onPullRefresh = { onComplete -> viewModel.refreshManual(onComplete) },
                    )
                    // 查看器叠在主内容之上，且不随网格的「扫描中」分支被拆掉（见 ViewerLayerHost）
                    ViewerLayerHost(
                        state = appState,
                        displayImages = displayImages,
                        viewerProvider = ::ensureViewer,
                        parentName = currentFolderName,
                        tagsByFile = viewModel.tagsByFile.value,
                        metadataById = viewModel.metadataById.value,
                    )
                }
            }
        }

        requestMediaPermissionIfNeeded()

        // 模拟器/Debug 构建：注册捏合注入广播（验证 FLIP 用，走生产回调链；Release 不注册）
        if (isEmulator() || applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            ContextCompat.registerReceiver(
                this,
                pinchDebugReceiver,
                IntentFilter("aurora.debug.PINCH"),
                ContextCompat.RECEIVER_EXPORTED,
            )
            ContextCompat.registerReceiver(
                this,
                ffiDebugReceiver,
                IntentFilter("aurora.debug.FFI_SMOKE"),
                ContextCompat.RECEIVER_EXPORTED,
            )
        }
    }

    /** 4.2 分享：系统分享面板（多图 ACTION_SEND_MULTIPLE，content:// URI + 读授权）。 */
    private fun shareUris(uris: List<Uri>) {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "image/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "分享图片"))
    }

    /**
     * 4.2 删除：API ≥ 30 走 MediaStore.createDeleteRequest（系统弹窗逐批授权，无需
     * 写权限）；< 30 无该 API，退化为直接逐条删（本应用自建媒体可成，三方媒体被拒
     * 只记日志，见 GalleryViewModel.deleteDirect）。完成后的索引对账都由 MediaStore
     * observer 自动完成。
     */
    private fun requestDelete(uris: List<Uri>) {
        if (uris.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                val pi = MediaStore.createDeleteRequest(contentResolver, uris)
                deleteLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
            } catch (e: Exception) {
                Log.w("AuroraKotlin", "[Delete] createDeleteRequest failed", e)
                Toast.makeText(this, "删除请求失败", Toast.LENGTH_SHORT).show()
            }
        } else {
            viewModel.deleteDirect(uris)
        }
    }

    /**
     * MediaStore 监听跟随前台生存期：后台不收通知（省电，也不做无谓重扫）。
     * 回前台时兜底对账一次——后台期间（监听已注销）MediaStore 的增删在这里补上；
     * 无实质变化时各 adapter 的幂等守卫不会 notifyDataSetChanged，界面纹丝不动。
     */
    override fun onStart() {
        super.onStart()
        viewModel.startMediaStoreObservation()
        viewModel.refreshFromForeground()
    }

    override fun onStop() {
        super.onStop()
        viewModel.stopMediaStoreObservation()
    }

    /**
     * 模拟器验证钩子：`adb shell am broadcast -a aurora.debug.PINCH --es scale 0.75`
     * 触发一次完整的捏合手势（走生产回调链），scale<1 收拢 / >1 张开。
     * `--es mode touch` 走合成双指 MotionEvent 的真实事件分发路径（含中途抬指/抖动）。
     */
    private val pinchDebugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val scale = intent.getStringExtra("scale")?.toFloatOrNull() ?: 0.75f
            val steps = intent.getStringExtra("steps")?.toIntOrNull() ?: 12
            val mode = intent.getStringExtra("mode") ?: "callback"
            val seed = intent.getStringExtra("seed")?.toLongOrNull() ?: 42L
            Log.i("AuroraKotlin", "[DebugPinch] inject mode=$mode scale=$scale steps=$steps seed=$seed")
            val listener = PinchGridSpanListener.lastInstance?.get() ?: return
            if (mode == "touch") listener.debugInjectTouchPinch(scale, steps, seed)
            else listener.debugInjectPinch(scale, steps)
        }
    }

    /**
     * M4a 0.3 冒烟钩子：`adb shell am broadcast -a aurora.debug.FFI_SMOKE`
     * 跑一遍 0.1 新导出的人物/专题/元数据读写（含「读不存在的行返回 null」的失败路径），
     * 结果只进日志。nonce 用来确认日志确实出自本轮。
     */
    private val ffiDebugReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            runFfiSmoke(intent.getStringExtra("nonce") ?: System.currentTimeMillis().toString())
        }
    }

    private fun isEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.MODEL.contains("Emulator") ||
            Build.MODEL.contains("Android SDK built for") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.PRODUCT.contains("sdk")

    private fun requestMediaPermissionIfNeeded() {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            viewModel.startScanIfNeeded()
        } else {
            requestPermission.launch(permission)
        }
    }
}

@Composable
fun App(
    state: AppState,
    folders: List<Folder>,
    images: List<Image>,
    /** 展示序列（过滤+排序后）由组合根算好传入：查看器的进入序列必须是同一条（M3 2.2）。 */
    displayImages: List<Image>,
    /** 侧栏标签 Section 的分组 + 计数（Rust 算好的顺序原样渲染，M4a 3.1）。 */
    tagGroups: List<TagGroup>,
    /** 全部专题（M4a 3.2 总览网格）。 */
    topics: List<uniffi.aurora_core.FfiTopic>,
    /** coverFileId → Image（专题卡片封面）。 */
    coverImagesById: Map<String, Image>,
    scanning: Boolean,
    thumbnailLoader: ThumbnailLoader,
    onFolderClick: (Folder) -> Unit,
    /** 点专题卡片 = 进专题详情（3.2）。 */
    onTopicClick: (uniffi.aurora_core.FfiTopic) -> Unit,
    /** 新建专题（3.2；parentId null=根专题，非 null=在该专题下建子专题）。 */
    onCreateTopic: (String, String?) -> Unit,
    /** 3.2 归入：把选中图加入专题（宿主落库 + 反馈）。 */
    onAddToTopic: (topicId: String, fileIds: Set<String>) -> Unit,
    /** 3.2 对称操作：从专题移除选中图。 */
    onRemoveFromTopic: (topicId: String, fileIds: Set<String>) -> Unit,
    /** 4.2 分享：解析选中项为 URI 后由宿主拉起系统分享面板。 */
    onShareSelection: (Set<String>) -> Unit,
    /** 4.2 删除：解析选中项为 URI 后由宿主发起删除请求（含系统确认）。 */
    onDeleteSelection: (Set<String>) -> Unit,
    /** 4.4 下拉刷新：宿主触发扫描，完成时回调 [onComplete]（指示器落勾）。 */
    onPullRefresh: ((onComplete: () -> Unit) -> Unit),
) {
    // 活动标签驱动 UI：folderId × folders 得出当前文件夹；viewMode 决定总览或文件夹网格
    val tab = state.activeTab
    val currentFolder = tab.folderId?.let { id -> folders.firstOrNull { it.id == id } }
    val context = LocalContext.current
    val density = LocalDensity.current
    // 4.4 下拉刷新的触发阈值（80dp，React threshold 同值）
    val ptrThresholdPx = with(density) { 80.dp.toPx() }

    // 4.3 返回链需要读取/关闭搜索胶囊（React 里是 searchInput focused 的判断），提升到这里
    var searchOpen by remember { mutableStateOf(false) }
    // 4.2 删除确认弹窗
    var showDeleteConfirm by remember { mutableStateOf(false) }
    // M4a 3.2 新建专题弹窗（TopicsOverview 的「新建专题」按钮触发）
    var showCreateTopic by remember { mutableStateOf(false) }
    // M4a 3.2 专题选择弹窗（选择模式「更多」→「加入专题…」触发）
    var showTopicPicker by remember { mutableStateOf(false) }
    // 3.2④ 建专题弹窗的目标父级：总览按钮=null（根专题），详情子专题区=当前专题
    var createTopicParent by remember { mutableStateOf<String?>(null) }
    // 4.4 下拉刷新状态（overview 与 browser 共用一个实例：同一时刻只有一个网格在组合）
    val ptrState = remember { PullToRefreshState() }

    if (scanning) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("扫描中…")
        }
        return
    }

    // 工具按钮按视图提供（2026-09-17 起）：文件夹内部 = 搜索/排序/视图/日期全量；
    // 总览 = 搜索（按文件夹名过滤）+ 排序 + 日期筛选（Folder.createdAt/modifiedAt，
    // Rust list_folders 子查询提供）。排序字段/方向是应用级状态（对齐 React：总览与
    // 文件网格共用同一 sortBy/sortDirection）。总览的视图循环（React folderLayoutMode）
    // 不做——文件夹卡片是等比正方形，adaptive/masonry 视觉与 grid 等价。
    //
    // 标签视图（M4a 4.1）走的也是 BROWSER + 网格，只是序列源换成「标签命中的全库图片」，
    // 所以这里不能只看 currentFolder 是否存在——在总览直接点标签时 folderId 为 null。
    val tagFilterTitle = tab.activeTags.joinToString("、") { it }
    val inBrowser =
        tab.viewMode == ViewMode.BROWSER && (currentFolder != null || tagFilterTitle.isNotEmpty())
    // M4a 3.2 总览：侧栏人物/标签/专题 Section 头部进入；专题详情 = TOPICS_OVERVIEW + activeTopicId
    val inTagsOverview = tab.viewMode == ViewMode.TAGS_OVERVIEW
    val inPeopleOverview = tab.viewMode == ViewMode.PEOPLE_OVERVIEW
    val inTopicsOverview = tab.viewMode == ViewMode.TOPICS_OVERVIEW
    val inTopicsList = inTopicsOverview && tab.activeTopicId == null
    val inTopicDetail = inTopicsOverview && tab.activeTopicId != null
    val currentTopicName = tab.activeTopicId?.let { id ->
        topics.firstOrNull { it.id == id }?.name
    }
    // 3.2④ 两层专题（对齐桌面：顶层只显示根专题 TopicModule:860；子专题区只渲染在根
    // 专题详情 :945/:2072——子专题里没有这个区，子专题不能再建子专题）
    val rootTopics = topics.filter { it.parentId == null }
    val childTopics = tab.activeTopicId?.let { id -> topics.filter { it.parentId == id } } ?: emptyList()
    // 当前详情里的专题是否根专题（子专题详情不渲染子专题区/建子专题入口）
    val currentTopicIsRoot = tab.activeTopicId?.let { id ->
        topics.firstOrNull { it.id == id }?.parentId == null
    } ?: false

    // 「更多」菜单项（3.2 归入入口；其余项归 4.3 收口）：
    //  - 文件夹网格里多选 → 「加入专题…」（桌面同位：文件右键菜单的添加到主题）
    //  - 专题详情里多选 → 「从专题移除」（对称操作）
    val moreActions = when {
        inBrowser -> listOf(
            SelectionMoreAction("加入专题…") { showTopicPicker = true },
        )
        inTopicDetail && tab.activeTopicId != null && tab.selectedFileIds.isNotEmpty() -> listOf(
            SelectionMoreAction("从专题移除") {
                onRemoveFromTopic(tab.activeTopicId!!, tab.selectedFileIds)
            },
        )
        else -> emptyList()
    }

    // 总览数据管道：过滤（搜索词/日期）→ 排序（「根目录图片」恒置顶在 sortFolders 内保证）。
    // remember 键齐备：任一条件变化才重算，文件夹列表量级小、开销可忽略。
    val displayFolders = remember(folders, tab.searchQuery, tab.dateFilter, state.sortBy, state.sortDirection) {
        filterFolders(
            sortFolders(folders, state.sortBy, state.sortDirection),
            tab.searchQuery,
            tab.dateFilter,
        )
    }

    // 3.2 数据管道：搜索/日期过滤 → 排序（分组在 FileGrid 内部完成）。提前到组合根算：
    // 4.1/4.2 的选择处理与选择栏计数在两个分支外就要用（展示序列 = 范围选择/全选的
    // 输入，选择栏 total = 当前展示数量），M3 查看器的进入序列也共用这一条。
    // 范围选择/全选的输入（当前展示顺序）。rememberUpdatedState：长按回调经 adapter 的
    // 首帧闭包转发，这里保证它读到的是最新展示序列
    val currentImageIds = rememberUpdatedState(displayImages.map { it.id })
    val currentFolderIds = rememberUpdatedState(displayFolders.map { it.id })

    // —— 4.1 编辑模式的操作语义（对齐 React useFileSelection 的安卓分支 + App.tsx 的
    //    handleFolder* 系列；框选按 2026-09-20 用户决定平板不做）——
    val onImageClick: (Image) -> Unit = { img ->
        if (state.selectionMode) state.toggleSelectedInMode(img.id) else state.openViewer(img.id)
    }
    val onImageLongPress: (Image) -> Unit = { img ->
        when {
            !state.selectionMode -> state.enterSelectionMode(img.id)
            img.id !in tab.selectedFileIds -> state.rangeSelect(img.id, currentImageIds.value)
            // 已选中项长按：React 是文件上下文菜单（M2 接入），当前无操作
        }
    }
    val onFolderCardClick: (Folder) -> Unit = { folder ->
        if (state.selectionMode) state.toggleSelectedInMode(folder.id) else onFolderClick(folder)
    }
    val onFolderCardLongPress: (Folder) -> Unit = { folder ->
        when {
            !state.selectionMode -> state.enterSelectionMode(folder.id)
            folder.id !in tab.selectedFileIds -> state.rangeSelect(folder.id, currentFolderIds.value)
        }
    }

    // —— M4a 3.1 / 4.1 侧栏与弹层点标签 = 单选筛选 ——
    // 序列源随之切换（见 GalleryViewModel.reloadImages：有标签 = 全库按标签取，
    // 无标签 = 当前文件夹），取数由组合根那条 LaunchedEffect 统一触发。
    val onTagClick: (String) -> Unit = { tag -> state.toggleTagFilter(tag) }

    // —— 4.3 返回手势链（D5 后：关弹层→关搜索→退选择→返回上级→总览再退=系统默认）。
    // 排序菜单/日期弹层/标签弹层是独立窗口（Dialog/BottomSheet），系统返回先被它们
    // 自己消费，不进本链。
    // M3 3.1：查看器插在「退选择模式」之前。它自带 dispatchKeyEvent 的梯子（幻灯片→抽屉→
    // 关闭）与 NativeViewerLayer 的 BackHandler，本链在查看器开着时整条让位——
    // 一次 back 只退一层，退的是查看器，不是 goBack()。
    BackHandler(enabled = tab.viewingFileId == null && (searchOpen || state.selectionMode || tab.history.canBack)) {
        when {
            searchOpen -> {
                // 对齐 React close-android-search：清词 + 关胶囊
                state.setSearchQuery("")
                searchOpen = false
            }

            state.selectionMode -> state.exitSelectionMode()

            else -> state.goBack()
        }
    }

    // 3.5 面板开合：侧栏在左、内容（TopBar + 网格）在右，开关时侧栏宽度收缩把内容
    // 推挤过去（SidebarPane 内做 300ms ease-out 动画，对齐 React SidebarPane）。
    Row(Modifier.fillMaxSize()) {
        SidebarPane(
            visible = state.layout.isSidebarVisible,
            modifier = Modifier.fillMaxHeight(),
        ) {
            // 侧栏文件夹列表用全量 folders：TopBar 搜索词只过滤总览网格（对齐 React
            // 侧栏树不被工具栏搜索过滤）
            TreeSidebar(
                folders = folders,
                currentFolderId = tab.folderId,
                onFolderClick = onFolderClick,
                // 头部点击 = 回主界面（React onNavigateHome，2026-09-20 用户要求）
                onNavigateHome = { state.navigateHome() },
                tagGroups = tagGroups,
                activeTags = tab.activeTags,
                onTagClick = onTagClick,
                // 人物/标签/专题 Section 头部 = 进对应总览（M4a 3.2）
                onPeopleOverviewClick = { state.openOverview(ViewMode.PEOPLE_OVERVIEW) },
                onTagsOverviewClick = { state.openOverview(ViewMode.TAGS_OVERVIEW) },
                onTopicsOverviewClick = { state.openOverview(ViewMode.TOPICS_OVERVIEW) },
                peopleOverviewSelected = inPeopleOverview,
                tagsOverviewSelected = inTagsOverview,
                topicsOverviewSelected = inTopicsOverview,
                foldersOverviewSelected = tab.viewMode == ViewMode.FOLDERS_OVERVIEW,
                browserActive = inBrowser,
                modifier = Modifier.fillMaxHeight(),
            )
        }
        Column(Modifier.weight(1f).fillMaxHeight()) {
            // 4.2 编辑模式：选择栏替换 TopBar（对齐 React ToolbarPane 的二选一结构）
            if (state.selectionMode) {
            SelectionBar(
                selectedCount = tab.selectedFileIds.size,
                // 专题详情（3.2）与文件夹网格同为图片选择；文件夹总览选的是文件夹
                totalCount = if (inBrowser || inTopicDetail) displayImages.size else displayFolders.size,
                    onToggleSelectAll = {
                        val ids = if (inBrowser) currentImageIds.value else currentFolderIds.value
                        if (tab.selectedFileIds.size >= ids.size) state.deselectAll()
                        else state.selectAll(ids)
                    },
                    onExit = { state.exitSelectionMode() },
                    onDelete = { showDeleteConfirm = true },
                    onShare = { onShareSelection(tab.selectedFileIds) },
                    onMore = {
                        // 仅剩总览（文件夹卡片选择）会走到这里——文件网格的「更多」
                        // 已是菜单（moreActions），见 SelectionBar
                        Toast.makeText(context, "更多操作将随 M4b 提供", Toast.LENGTH_SHORT).show()
                    },
                    moreActions = moreActions,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                TopBar(
                    title = when {
                        tagFilterTitle.isNotEmpty() -> "标签 · $tagFilterTitle"
                        inTagsOverview -> "标签"
                        inPeopleOverview -> "人物"
                        inTopicDetail -> currentTopicName ?: "专题"
                        inTopicsList -> "专题"
                        else -> currentFolder?.name ?: "文件夹"
                    },
                    canBack = tab.history.canBack,
                    onBack = { state.goBack() },
                    // 总览是从别处推入历史栈的位置，可退；文件夹总览（栈底）不显示返回键
                    showBack = inBrowser || inTagsOverview || inPeopleOverview || inTopicsOverview,
                    sidebarVisible = state.layout.isSidebarVisible,
                    onToggleSidebar = { state.toggleSidebar() },
                    searchQuery = tab.searchQuery,
                    onSearchQueryChange = { state.setSearchQuery(it) },
                    searchOpen = searchOpen,
                    onSearchOpenChange = { searchOpen = it },
                    searchPlaceholder = when {
                        inTagsOverview -> "搜索标签"
                        inBrowser -> "搜索图片"
                        else -> "搜索文件夹"
                    },
                    dateFilter = tab.dateFilter,
                    onDateFilterChange = { state.setDateFilter(it) },
                    sortBy = state.sortBy,
                    onSortChange = { state.sortBy = it },
                    sortDirection = state.sortDirection,
                    onSortDirectionToggle = {
                        state.sortDirection =
                            if (state.sortDirection == SortDirection.ASC) SortDirection.DESC else SortDirection.ASC
                    },
                    groupBy = state.groupBy,
                    onGroupByChange = { state.groupBy = it },
                    layoutMode = tab.layoutMode,
                    onLayoutModeChange = { mode -> state.updateActiveTab { it.copy(layoutMode = mode) } },
                    // 标签弹层与侧栏标签区同一份数据、同一个点击行为（M4a 3.1 / 4.1）
                    tagGroups = tagGroups,
                    activeTags = tab.activeTags,
                    onTagClick = onTagClick,
                    showSearch = true,
                    showSortMenu = true,
                    showViewMode = inBrowser,
                    showDateFilter = true,
                    showGroupBy = inBrowser,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            when {
                // M4a 3.2 标签总览：分组标签卡片网格，点卡片 = 进该标签的筛选视图。
                // 数据是本地库的词表（reloadTagState 快照），无 MediaStore 依赖，不接下拉刷新。
                inTagsOverview -> TagsOverview(
                    tagGroups = tagGroups,
                    onTagClick = onTagClick,
                    searchQuery = tab.searchQuery,
                    initialScrollAnchor = state.tagsOverviewScrollAnchor,
                    onScrollChanged = { state.tagsOverviewScrollAnchor = it },
                    emptyText = if (tab.searchQuery.isNotBlank()) "无匹配标签" else "暂无标签",
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
                // 人物总览：D11=③ 的空壳（数据源在 M6），只有正确空态
                inPeopleOverview -> PeopleOverview(Modifier.fillMaxWidth().weight(1f))
                // 专题总览列表（3.2）：根专题卡片网格 + 常驻「新建专题」按钮
                inTopicsList -> TopicsOverview(
                    topics = rootTopics,
                    coverImages = coverImagesById,
                    thumbnailLoader = thumbnailLoader,
                    onTopicClick = { onTopicClick(it) },
                    onCreateTopic = {
                        createTopicParent = null
                        showCreateTopic = true
                    },
                    initialScrollAnchor = state.topicsOverviewScrollAnchor,
                    onScrollChanged = { state.topicsOverviewScrollAnchor = it },
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
                // 专题详情（3.2④ 两层）：根专题详情有子专题区（含建子专题入口）；
                // 子专题详情没有这个区（桌面 :2072 `!currentTopic.parentId` 同构）
                inTopicDetail -> Column(Modifier.fillMaxWidth().weight(1f)) {
                    if (currentTopicIsRoot) {
                        TopicChildrenSection(
                            children = childTopics,
                            coverImages = coverImagesById,
                            thumbnailLoader = thumbnailLoader,
                            onChildClick = { onTopicClick(it) },
                            onCreateChild = {
                                createTopicParent = tab.activeTopicId
                                showCreateTopic = true
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    if (displayImages.isEmpty()) {
                        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                            val hasCondition = tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                            val emptyText = when {
                                hasCondition -> "无匹配图片"
                                tagFilterTitle.isNotEmpty() -> "标签「$tagFilterTitle」下没有图片"
                                else -> "专题里还没有图片"
                            }
                            Text(emptyText, color = AuroraTheme.colors.textSecondary)
                        }
                    } else {
                        Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                            FileGrid(
                                images = displayImages,
                                selectedIds = tab.selectedFileIds,
                                thumbnailLoader = thumbnailLoader,
                                onItemClick = onImageClick,
                                onItemLongClick = onImageLongPress,
                                layoutMode = tab.layoutMode,
                                groupBy = state.groupBy,
                                level = state.gridLevel,
                                onLevelChange = { state.gridLevel = it },
                                sidebarVisible = state.layout.isSidebarVisible,
                                pullToRefreshState = null,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                }
                // 文件夹内网格（选择/查看器共用同一展示序列）
                inBrowser -> {
                    if (displayImages.isEmpty()) {
                        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                            val hasCondition = tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                            val emptyText = when {
                                hasCondition -> "无匹配图片"
                                tagFilterTitle.isNotEmpty() -> "标签「$tagFilterTitle」下没有图片"
                                else -> "文件夹为空"
                            }
                            Text(emptyText, color = AuroraTheme.colors.textSecondary)
                        }
                    } else {
                        Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                            FileGrid(
                                images = displayImages,
                                selectedIds = tab.selectedFileIds,
                                thumbnailLoader = thumbnailLoader,
                                onItemClick = onImageClick,
                                onItemLongClick = onImageLongPress,
                                layoutMode = tab.layoutMode,
                                groupBy = state.groupBy,
                                level = state.gridLevel,
                                onLevelChange = { state.gridLevel = it },
                                sidebarVisible = state.layout.isSidebarVisible,
                                pullToRefreshState = ptrState,
                                onPullToRefresh = onPullRefresh,
                                modifier = Modifier.fillMaxSize(),
                            )
                            // 4.4 指示器覆盖在网格上层（pointer-events 由 Canvas 天然不拦截触摸）
                            PullToRefreshIndicator(
                                state = ptrState,
                                thresholdPx = ptrThresholdPx,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                }
                // 文件夹总览（栈底 / 主界面）
                else -> {
                    // clipToBounds：指示器空闲时藏在容器上方（负偏移），不裁剪会透出到工具栏
                    Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                        FoldersOverview(
                            folders = displayFolders,
                            thumbnailLoader = thumbnailLoader,
                            onFolderClick = onFolderCardClick,
                            onFolderLongClick = onFolderCardLongPress,
                            level = state.gridLevel,
                            onLevelChange = { state.gridLevel = it },
                            // 3.5 列数预测：侧栏开合时按目标状态最终宽度一次性收敛列数
                            sidebarVisible = state.layout.isSidebarVisible,
                            // 4.1 选中态：总览的文件夹卡片同样高亮（边框 + 勾）
                            selectedIds = tab.selectedFileIds,
                            // 滚动位置恢复：离开总览（进文件夹）前记录的位置在重建时归位
                            initialScrollTop = state.overviewScrollTop,
                            onScrollChanged = { state.overviewScrollTop = it },
                            emptyText = if (tab.searchQuery.isNotBlank() || tab.dateFilter.start != null) "无匹配文件夹"
                            else "暂无文件夹",
                            pullToRefreshState = ptrState,
                            onPullToRefresh = onPullRefresh,
                            modifier = Modifier.fillMaxSize(),
                        )
                        // 4.4 指示器覆盖在网格上层（pointer-events 由 Canvas 天然不拦截触摸）
                        PullToRefreshIndicator(
                            state = ptrState,
                            thresholdPx = ptrThresholdPx,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }

    if (showCreateTopic) {
        CreateTopicDialog(
            onDismiss = { showCreateTopic = false },
            onConfirm = { name ->
                showCreateTopic = false
                onCreateTopic(name, createTopicParent)
            },
        )
    }

    if (showTopicPicker) {
        TopicPickerDialog(
            topics = topics,
            onDismiss = { showTopicPicker = false },
            onPick = { topic ->
                showTopicPicker = false
                onAddToTopic(topic.id, tab.selectedFileIds)
            },
        )
    }

    if (showDeleteConfirm) {
        val n = tab.selectedFileIds.size
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("删除所选") },
            text = {
                Text(
                    if (inBrowser || inTopicDetail) "确定删除所选的 $n 张图片吗？删除后可尝试在系统相册的回收站中找回。"
                    else "确定删除所选 $n 个文件夹内的全部图片吗？删除后可尝试在系统相册的回收站中找回。",
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    onDeleteSelection(tab.selectedFileIds)
                }) {
                    Text("删除", color = Color(0xFFEF4444))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }
}
