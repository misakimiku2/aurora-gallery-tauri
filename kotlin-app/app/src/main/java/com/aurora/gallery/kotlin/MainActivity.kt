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
import org.json.JSONArray
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.ui.components.FileGrid
import com.aurora.gallery.kotlin.ui.components.WelcomeFlow
import com.aurora.gallery.kotlin.ui.components.CreateTopicDialog
import com.aurora.gallery.kotlin.ui.components.EditTagsDialog
import com.aurora.gallery.kotlin.ui.components.PeopleOverview
import com.aurora.gallery.kotlin.ui.components.PersonPickerDialog
import com.aurora.gallery.kotlin.ui.components.PersonSortMenuContent
import com.aurora.gallery.kotlin.ui.components.AvatarCandidate
import com.aurora.gallery.kotlin.ui.components.PersonAvatarCropDialog
import com.aurora.gallery.kotlin.ui.components.SelectionBar
import com.aurora.gallery.kotlin.ui.components.SelectionMoreAction
import com.aurora.gallery.kotlin.ui.components.IconClipboard
import com.aurora.gallery.kotlin.ui.components.IconCopy
import com.aurora.gallery.kotlin.ui.components.IconFolderInput
import com.aurora.gallery.kotlin.ui.components.IconFrame
import com.aurora.gallery.kotlin.ui.components.IconImage
import com.aurora.gallery.kotlin.ui.components.IconBrain
import com.aurora.gallery.kotlin.ui.components.IconLayout
import com.aurora.gallery.kotlin.ui.components.IconPencil
import com.aurora.gallery.kotlin.ui.components.IconScanSearch
import com.aurora.gallery.kotlin.ui.components.IconSparkles
import com.aurora.gallery.kotlin.ui.components.IconTag
import com.aurora.gallery.kotlin.ui.components.IconTrash2
import com.aurora.gallery.kotlin.ui.components.TagsOverview
import com.aurora.gallery.kotlin.ui.components.TargetPickerDialog
import com.aurora.gallery.kotlin.ui.components.TopicChildrenSection
import com.aurora.gallery.kotlin.ui.components.TopicCollapsibleDetail
import com.aurora.gallery.kotlin.ui.components.TopicDashedEmpty
import com.aurora.gallery.kotlin.ui.components.TopicHero
import com.aurora.gallery.kotlin.ui.components.TopicSectionHeader
import com.aurora.gallery.kotlin.ui.components.TopicSortOption
import com.aurora.gallery.kotlin.ui.components.TopicsOverview
import com.aurora.gallery.kotlin.ui.components.TopicPickerDialog
import com.aurora.gallery.kotlin.ui.components.LanTopicPickerDialog
import com.aurora.gallery.kotlin.ui.components.LanFolderPickerDialog
import com.aurora.gallery.kotlin.ui.components.LanPickerMode
import com.aurora.gallery.kotlin.ui.components.LanPersonEditDialog
import com.aurora.gallery.kotlin.ui.components.SettingsHost
import com.aurora.gallery.kotlin.ui.components.SettingsCategory
import com.aurora.gallery.kotlin.ui.components.UpdateDialog
import com.aurora.gallery.kotlin.ui.components.SidebarPane
import com.aurora.gallery.kotlin.ui.components.ColorPickerPane
import com.aurora.gallery.kotlin.ui.components.ColorPickerPanelContent
import com.aurora.gallery.kotlin.ui.components.PhoneSidebarDrawerHost
import com.aurora.gallery.kotlin.ui.components.SIDEBAR_WIDTH_DP
import com.aurora.gallery.kotlin.ui.components.TopBar
import com.aurora.gallery.kotlin.ui.components.TreeSidebar
import com.aurora.gallery.kotlin.ui.components.filterFolders
import com.aurora.gallery.kotlin.ui.components.rememberDisplayImages
import com.aurora.gallery.kotlin.ui.components.sortFolders
import com.aurora.gallery.kotlin.ui.components.sortTopicsForDisplay
import com.aurora.gallery.kotlin.ui.components.FoldersOverview
import com.aurora.gallery.kotlin.ui.components.PinchGridSpanListener
import com.aurora.gallery.kotlin.ui.components.PullToRefreshIndicator
import com.aurora.gallery.kotlin.ui.components.PullToRefreshState
import com.aurora.gallery.kotlin.ui.isCompactWidth
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.ui.theme.AuroraPalettes
import android.graphics.RectF
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import com.aurora.gallery.kotlin.canvas.CanvasScreen
import com.aurora.gallery.kotlin.canvas.AddResult
import com.aurora.gallery.kotlin.viewer.NativeGalleryView
import com.aurora.gallery.kotlin.viewer.PhotoRectQuery
import com.aurora.gallery.kotlin.viewer.ViewerLayerHost
import com.aurora.gallery.kotlin.viewer.ViewerTransition
import com.aurora.gallery.kotlin.viewer.applyViewerTheme
import com.aurora.gallery.kotlin.viewer.dialogs.RenameDialog
import com.aurora.gallery.kotlin.state.AppState
import com.aurora.gallery.kotlin.state.AppSettings
import com.aurora.gallery.kotlin.state.LAN_FOLDER_ID_PREFIX
import com.aurora.gallery.kotlin.state.SearchScope
import com.aurora.gallery.kotlin.state.WelcomeFlowState
import com.aurora.gallery.kotlin.state.WelcomeStep
import com.aurora.gallery.kotlin.state.toAiConfig
import com.aurora.gallery.kotlin.state.lanRemotePathOrNull
import com.aurora.gallery.kotlin.state.lanPersonIdOrNull
import com.aurora.gallery.kotlin.state.lanTopicIdOrNull
import com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID
import com.aurora.gallery.kotlin.state.lanTagFilterOrNull
import com.aurora.gallery.kotlin.state.localPersonFolderId
import com.aurora.gallery.kotlin.state.localPersonIdOrNull
import com.aurora.gallery.kotlin.ui.components.GroupBy
import com.aurora.gallery.kotlin.ui.components.ColorDbStatsUi as PanelColorStats
import com.aurora.gallery.kotlin.ui.components.ColorTaskState as PanelColorTask
import com.aurora.gallery.kotlin.state.LayoutVisibility
import com.aurora.gallery.kotlin.state.SortDirection
import com.aurora.gallery.kotlin.state.SortOption
import com.aurora.gallery.kotlin.state.ViewMode
import uniffi.aurora_core.Folder
import com.aurora.gallery.kotlin.ui.components.FoldersOverviewState
import uniffi.aurora_core.Image
import uniffi.aurora_core.TagGroup
import org.json.JSONException
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    /** M4b 2.1 设置面板开合（侧栏「设置」行触发；对话框在 setContent 里渲染）。 */
    private var showSettings by mutableStateOf(false)

    /**
     * 设置面板打开时直接落的分类（null = 默认入口）。仅侧栏「网络」行未连接跳转时
     * 置 LAN（2026-09-26 验收反馈）；普通设置入口（设置行/TopBar）在打开前重置为 null。
     */
    private var settingsInitialCategory by mutableStateOf<SettingsCategory?>(null)

    /**
     * 系统深色档快照（M4c）：settings.theme = "system" 时的实际档位来源。manifest 声明了
     * uiMode configChange（切系统深浅不重建 Activity），系统档变化只有
     * [onConfigurationChanged] 能接住——onCreate 先取一次初值供冷启动定档。
     */
    private var systemDark by mutableStateOf(false)

    // —— 首启欢迎向导（启动流程优化 2026-09-29，设计文档 4.3）——
    // 仅当无 onboarded 标记且媒体权限未授予时显示；状态机见 WelcomeFlowState（JUnit 覆盖）。
    private var showWelcome by mutableStateOf(false)
    private var welcomeState by mutableStateOf(WelcomeFlowState.initial(false))
    private var welcomePermissionDenied by mutableStateOf(false)

    /**
     * 数据与 UI 状态都住在 GalleryViewModel（跨旋转重建保留）。factory 只在 ViewModel
     * 首次创建时求值，这里的横竖屏判断即初始面板可见性，旋转后不会被重算覆盖。
     */
    private val viewModel: GalleryViewModel by viewModels {
        GalleryViewModel.factory(
            application,
            LayoutVisibility(
                // 横屏开侧栏（React layoutSettings 安卓分支）；M8b 1.2 起横屏手机（高 <480dp，
                // 抽屉形态）冷启动收起——抽屉启动即开会盖住首帧主内容；平板（高 ≥480dp）不变
                isSidebarVisible =
                    resources.configuration.orientation != Configuration.ORIENTATION_PORTRAIT &&
                    resources.configuration.screenHeightDp >= 480,
            ),
        )
    }

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            viewModel.startScanIfNeeded()
            // 欢迎向导权限步：授权即推进状态机（向导继续走，扫描已在后台跑）
            if (showWelcome) welcomeState = welcomeState.onPermissionGranted()
            // Q 传统视图：READ 到手后补请求 WRITE（全新安装后的首次启动走这里）
            requestWritePermissionIfNeeded()
        } else if (showWelcome) {
            welcomePermissionDenied = true
        }
        requestNotificationPermissionIfNeeded()
    }

    /** 删除被系统拦下、发起 createDeleteRequest 后要重试的那几行（授权成功才执行）。 */
    private var pendingDeleteRetry: (() -> Unit)? = null

    /**
     * 4.2 删除：createDeleteRequest 的结果（**只对被系统拦下的那几行**发起，见
     * [requestDelete] 与 [GalleryViewModel.deleteConsentFallback]）。**允许 = 系统
     * 已经把那批 uri 删掉**（AOSP PermissionActivity 允许后直接执行删除）→ retry 走
     * deleteDirect 重删是幂等的（行已不存在返回 0 也算成功），计数/收尾/退出选择模式
     * 都由 onDone 统一负责；拒绝 → 只提示。observer 的重扫做兜底。
     */
    private val deleteLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        val retry = pendingDeleteRetry
        pendingDeleteRetry = null
        if (result.resultCode == RESULT_OK && retry != null) {
            retry()
        } else {
            Toast.makeText(this, "未获系统删除授权，操作已取消", Toast.LENGTH_SHORT).show()
        }
    }

    // —— M6a 阶段 4：LAN 上传（系统照片选择器多选 → 逐个 multipart）——

    /**
     * 系统照片选择器（PickMultipleVisualMedia：API 33+ 的照片选择器，无需存储权限）。
     * 选择结果带着 [pendingUploadTargetDir]（发起时记录的远端目标目录）交给
     * [startLanUpload]。
     */
    private val uploadLauncher = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(LAN_UPLOAD_MAX_ITEMS),
    ) { uris ->
        val target = pendingUploadTargetDir
        pendingUploadTargetDir = null
        if (target != null && uris.isNotEmpty()) startLanUpload(uris, target)
    }

    /** 上传发起时记录的目标远端目录（共享根为空串）。 */
    private var pendingUploadTargetDir: String? = null

    /**
     * 上传入口（LAN 目录网格 TopBar）。allow_upload=false（门禁位来自 browse/
     * all_image_folders 尾部，D32 拍板后默认 true——置灰态=桌面端手动收紧的真实状态）：
     * 入口已置灰，点击再提示需桌面端开启。
     */
    private fun launchLanUpload(targetDir: String) {
        if (!viewModel.lanAllowUpload.value) {
            Toast.makeText(
                this,
                "桌面端未开启「允许上传」，请先在桌面端共享设置中开启",
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        pendingUploadTargetDir = targetDir
        uploadLauncher.launch(
            androidx.activity.result.PickVisualMediaRequest(
                ActivityResultContracts.PickVisualMedia.ImageOnly,
            ),
        )
    }

    /** 逐个上传：进度与完成都是 Toast（清单阶段 4 口径），完成后 VM 刷新当前目录列表。 */
    private fun startLanUpload(uris: List<Uri>, targetDir: String) {
        Toast.makeText(this, "开始上传 ${uris.size} 张…", Toast.LENGTH_SHORT).show()
        viewModel.uploadUrisToLan(
            uris,
            targetDir,
            onProgress = { idx, total, name, ok, err ->
                val msg = if (ok) "上传成功（$idx/$total）$name"
                else "上传失败（$idx/$total）$name${err?.let { "：$it" } ?: ""}"
                Log.i("AuroraKotlin", "[Lan] $msg")
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            },
            onDone = { ok, fail ->
                val msg = if (fail == 0) "上传完成（$ok 张）" else "上传完成：成功 $ok 张，失败 $fail 张"
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
            },
        )
    }

    // —— M4b 1.1 文件操作的批量授权（重命名/移动走 createWriteRequest，复制不弹）——

    /** [requestWriteAccess] 发起的系统授权弹窗回来后要继续的动作（一次一条）。 */
    private var pendingWriteCallback: (() -> Unit)? = null

    /**
     * createWriteRequest 的弹窗结果：允许 → 继续挂起的写操作；拒绝 → 只提示，动作丢弃。
     * 授权针对**一批** uri（多选攒一次请求，规划五要点①），继续时整批一起执行。
     */
    private val writeLauncher = registerForActivityResult(
        ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        val callback = pendingWriteCallback
        pendingWriteCallback = null
        if (result.resultCode == RESULT_OK) {
            callback?.invoke()
        } else {
            Toast.makeText(this, "未获系统写入授权，操作已取消", Toast.LENGTH_SHORT).show()
        }
    }

    /** API < 30 的写权限兜底（manifest WRITE_EXTERNAL_STORAGE maxSdkVersion 已去掉）。 */
    private val writePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val callback = pendingWriteCallback
        pendingWriteCallback = null
        if (granted) {
            callback?.invoke()
        } else {
            Toast.makeText(this, "未获存储写权限，操作已取消", Toast.LENGTH_SHORT).show()
        }
    }

    /** 首启主动请求 WRITE 的独立出口（不带挂起写操作——只为把权限拿到手）。 */
    private val writeStoragePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 拒绝则写操作会失败并提示，这里无需动作 */ }

    /** Q 传统视图（API ≤ 29）的 WRITE 主动请求：**全新安装后若无人请求它**，直写共享
     *  存储抛的是普通 SecurityException——被写闭包静默吞掉，四种文件操作间接全失败
     *  且无提示（2026-10-07 荣耀真机全新安装实测）。READ 授权回调与本函数都会调它。 */
    private fun requestWritePermissionIfNeeded() {
        if (Build.VERSION.SDK_INT <= 29 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            writeStoragePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
    }

    /**
     * 对一批文件请求 MediaStore 写授权（**兜底**：只在直写被系统拦下时才走到这里，
     * 见 [writeConsentFor]），允许后继续 [onGranted]。API ≥ 30 走 createWriteRequest
     * （授权是持久的，同一行只弹一次）；< 30 走 WRITE_EXTERNAL_STORAGE 运行时权限。
     * 复制（insert 新行）不经过这里。
     */
    private fun requestWriteAccess(uris: List<Uri>, onGranted: () -> Unit) {
        if (uris.isEmpty()) return
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                pendingWriteCallback = onGranted
                val pi = MediaStore.createWriteRequest(contentResolver, uris.distinct())
                writeLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
            } catch (e: Exception) {
                pendingWriteCallback = null
                Log.w("AuroraKotlin", "[FileOp] createWriteRequest failed", e)
                Toast.makeText(this, "授权请求失败", Toast.LENGTH_SHORT).show()
            }
        } else {
            val permission = Manifest.permission.WRITE_EXTERNAL_STORAGE
            if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) {
                onGranted()
            } else {
                pendingWriteCallback = onGranted
                writePermissionLauncher.launch(permission)
            }
        }
    }

    /**
     * 写兜底授权（传给 VM 的 onBlocked）：直写时被系统拦下的行（非本应用创建且未授权过）
     * 先看能否走「管理媒体」免弹窗路线（[writeConsentFor] → [withMediaWriteConsent]），
     * 不行再发**一次**批量 createWriteRequest，允许后只重试那几行。App 自有/已授权的行
     * 根本走不到这里。
     */
    private fun writeConsentFor(buildOp: (List<Uri>) -> JSONObject): (List<Uri>, () -> Unit) -> Unit =
        { blocked, retry ->
            withMediaWriteConsent(buildOp(blocked)) { requestWriteAccess(blocked) { retry() } }
        }

    /** 已授予后/回程续跑中再次被拦：只走批量授权兜底，不再弹引导。 */
    private val plainWriteConsent: (List<Uri>, () -> Unit) -> Unit = { blocked, retry ->
        requestWriteAccess(blocked) { retry() }
    }

    // —— 2026-09-28 免弹窗终版：MANAGE_EXTERNAL_STORAGE（「所有文件」特殊权限，API 30+）——
    //
    // 直写被系统拦下的行（相机/微信等其它应用创建的照片）只能兜底弹 createWriteRequest /
    // createDeleteRequest，而 **createWriteRequest 的授权是按单张照片的**——改另一张就会
    // 再弹一次（用户诉求：一次开启、此后永不弹）。能做到「一次永久」的只有「所有文件
    // 访问」（Solid Explorer 同款权限）：授予后直写 update/delete/insert 一律放行。
    // 「管理媒体」(MANAGE_MEDIA) 只让 createDeleteRequest 静默，对 update 无效，故不再
    // 用它做引导目标（权限仍声明，开了也不碍事）。
    //
    // 该权限没有运行时弹窗形态，只能引导去系统设置开一次开关。**待执行操作持久化在
    // SharedPreferences**（而非内存闭包）：真机实测从设置页回来时内存 retry 会丢
    // （华为进程管控环境，原因不可观测——app 日志被系统吞），SP 对重建/回收都免疫；
    // 回程 onResume 消费一次，已授予则重发整批操作（对已成功的部分重跑是幂等的），
    // 未授予则提示重做。

    /** 已授予「所有文件访问」= 直写任何媒体行都放行（API 30+；模拟器/真机实测一致）。 */
    private fun hasAllFilesAccess(): Boolean =
        Build.VERSION.SDK_INT >= 30 && android.os.Environment.isExternalStorageManager()

    /** 待执行操作的持久化仓（跨「去开启」往返；读即清，避免重复执行）。 */
    private val mediaOpPrefs by lazy { getSharedPreferences("aurora_media_write", MODE_PRIVATE) }

    private fun savePendingOp(op: JSONObject) {
        mediaOpPrefs.edit().putString("pending_op", op.toString()).apply()
    }

    private fun consumePendingOp(): JSONObject? =
        mediaOpPrefs.getString("pending_op", null)?.let { raw ->
            mediaOpPrefs.edit().remove("pending_op").apply()
            runCatching { JSONObject(raw) }.getOrNull()
        }

    private fun clearPendingOp() {
        mediaOpPrefs.edit().remove("pending_op").apply()
    }

    /** 待执行操作的统一形态：type=delete/move 用 `uris`；rename 用 `targets`=[[uri,新名]]。 */
    private fun opJson(type: String, uris: List<Uri>): JSONObject =
        JSONObject().put("type", type).put("uris", JSONArray(uris.map { it.toString() }))

    /** 本次会话已引导过一次：用户选「仅本次」就不再烦，冷启动后才再问。 */
    private var allFilesGuideShown = false

    /**
     * 被系统拦下时的分流：Android 11+ 且未授予「所有文件访问」→ 弹一次应用内引导，
     * [pendingOp] 先落 SP，用户「去开启」后跳系统设置，回来 [onResume] 消费 SP 重发整批
     * 操作（授予则直写成功，且此后任何照片都不再弹）；「仅本次」/已引导过/低版本 → 清 SP
     * 走 [fallback] 逐张授权（createWriteRequest）。
     */
    private fun withMediaWriteConsent(pendingOp: JSONObject, fallback: () -> Unit) {
        if (hasAllFilesAccess() || Build.VERSION.SDK_INT < 30 || allFilesGuideShown) {
            fallback()
            return
        }
        allFilesGuideShown = true
        savePendingOp(pendingOp)
        Log.i("AuroraKotlin", "[FileOp] all-files guide shown (direct write blocked)")
        android.app.AlertDialog.Builder(this)
            .setTitle("开启「所有文件」权限免弹窗")
            .setMessage(
                "这台手机上的照片多由相机、微信等其它应用创建，安卓默认要求逐张授权才能修改。" +
                    "在接下来的系统设置里允许本应用访问「所有文件」后，改名/移动/复制/删除都会" +
                    "直接执行，此后不再弹出任何系统授权窗。",
            )
            .setPositiveButton("去开启") { d, _ ->
                d.dismiss()
                val intent = Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                    .setData(Uri.parse("package:$packageName"))
                try {
                    startActivity(intent)
                } catch (e: Exception) {
                    Log.w("AuroraKotlin", "[FileOp] ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION unavailable", e)
                    try {
                        startActivity(Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    } catch (e2: Exception) {
                        Log.w("AuroraKotlin", "[FileOp] all-files settings unavailable", e2)
                        clearPendingOp()
                        fallback()
                    }
                }
            }
            .setNegativeButton("仅本次") { d, _ ->
                d.dismiss()
                clearPendingOp()
                fallback()
            }
            .setOnCancelListener {
                clearPendingOp()
                fallback()
            }
            .show()
    }

    /** 从设置页回来：消费 SP 里待执行的操作（[onResume] 专用，见 [withMediaWriteConsent]）。 */
    private fun dispatchPendingOp(op: JSONObject) {
        val uris = op.getJSONArray("uris").let { arr ->
            List(arr.length()) { Uri.parse(arr.getString(it)) }
        }
        when (op.optString("type")) {
            "delete" -> requestDelete(uris)
            "rename" -> {
                val tArr = op.getJSONArray("targets")
                val targets = List(tArr.length()) { i ->
                    Uri.parse(tArr.getJSONArray(i).getString(0)) to tArr.getJSONArray(i).getString(1)
                }
                viewModel.renameFiles(
                    targets,
                    onDone = { n ->
                        Toast.makeText(
                            this,
                            if (n > 0) "已重命名" else "重命名失败",
                            Toast.LENGTH_SHORT,
                        ).show()
                    },
                    onBlocked = plainWriteConsent,
                )
            }
            "move" -> {
                val relPath = op.getString("relPath")
                viewModel.moveFiles(
                    uris,
                    relPath,
                    onDone = { n ->
                        Toast.makeText(
                            this,
                            if (n > 0) "已移动 $n 张" else "移动失败",
                            Toast.LENGTH_SHORT,
                        ).show()
                    },
                    onBlocked = plainWriteConsent,
                )
            }
        }
    }

    /** 文件操作统一入口：把 file id 解析成 content uri 交给 [op]（读索引，只解析一次）。 */
    private fun withResolvedUris(fileIds: Collection<String>, op: (List<Uri>) -> Unit) {
        viewModel.resolveFileUris(fileIds) { uris ->
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可操作的文件", Toast.LENGTH_SHORT).show()
            } else {
                op(uris)
            }
        }
    }

    // —— M4b 2.3 设置面板：缓存清理 + 备份导出/导入 ——

    private fun computeCacheSizeText(): String {
        fun dirSize(dir: java.io.File): Long =
            dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
        val cacheDir = cacheDir
        val total = if (cacheDir.exists()) dirSize(cacheDir) else 0L
        // M4c：去掉 M4b 的「=」前缀（测试反馈观感异常），改「约」表达估算值语义
        return when {
            total >= 1L shl 20 -> "约 %.1f MB".format(total.toDouble() / (1L shl 20))
            total >= 1024 -> "约 %.1f KB".format(total.toDouble() / 1024)
            else -> "$total B"
        }
    }

    private fun clearCache() {
        lifecycleScope.launch {
            val freed = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                fun dirSize(dir: java.io.File): Long =
                    dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }
                val before = if (cacheDir.exists()) dirSize(cacheDir) else 0L
                cacheDir.deleteRecursively()
                cacheDir.mkdirs()
                before
            }
            Toast.makeText(
                this@MainActivity,
                "缓存已清理（释放 %.1f MB）".format(freed.toDouble() / (1L shl 20)),
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    /** 备份导入（2.3）：SAF 选 JSON → 词表并集 + 人物/专题按 id 去重合并（React 同语义）。 */
    private val importBackupLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) importBackupFrom(uri)
    }

    private fun importBackupFrom(uri: Uri) {
        lifecycleScope.launch {
            val report = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                var tagsAdded = 0
                var peopleAdded = 0
                var topicsAdded = 0
                try {
                    val text = contentResolver.openInputStream(uri)?.use { input ->
                        input.readBytes().toString(Charsets.UTF_8)
                    } ?: throw IllegalStateException("openInputStream failed")
                    val json = org.json.JSONObject(text)
                    val tags = json.optJSONArray("tags")
                    val existingIds = HashSet<String>()
                    if (tags != null) {
                        val grouped = uniffi.aurora_core.getGroupedTags(viewModel.settings.value.language)
                        grouped.forEach { g -> g.tags.forEach { existingIds.add(it.tag) } }
                        for (i in 0 until tags.length()) {
                            val tag = tags.getString(i).trim()
                            if (tag.isNotEmpty() && tag !in existingIds) {
                                uniffi.aurora_core.addTagToVocabulary(tag)
                                tagsAdded++
                            }
                        }
                    }
                    val people = json.optJSONObject("people")
                    if (people != null) {
                        val existing = uniffi.aurora_core.getAllPeople().associateBy { it.id }
                        for (key in people.keys()) {
                            if (key in existing) continue
                            val p = people.getJSONObject(key)
                            uniffi.aurora_core.upsertPerson(
                                uniffi.aurora_core.FfiPerson(
                                    id = p.optString("id", key),
                                    name = p.optString("name", key),
                                    coverFileId = "",
                                    count = 0,
                                    description = p.optString("description").takeIf { it.isNotEmpty() },
                                    faceBox = null,
                                    updatedAt = null,
                                    characterTagName = null,
                                    characterTagIndex = null,
                                ),
                            )
                            peopleAdded++
                        }
                    }
                    val topics = json.optJSONObject("topics")
                    if (topics != null) {
                        val existing = uniffi.aurora_core.getAllTopics().associateBy { it.id }
                        for (key in topics.keys()) {
                            if (key in existing) continue
                            val t = topics.getJSONObject(key)
                            val peopleIds = mutableListOf<String>()
                            t.optJSONArray("peopleIds")?.let { arr ->
                                for (i in 0 until arr.length()) peopleIds.add(arr.getString(i))
                            }
                            val now = System.currentTimeMillis()
                            uniffi.aurora_core.upsertTopic(
                                uniffi.aurora_core.FfiTopic(
                                    id = t.optString("id", key),
                                    parentId = t.optString("parentId").takeIf { it.isNotEmpty() },
                                    name = t.optString("name", key),
                                    description = t.optString("description").takeIf { it.isNotEmpty() },
                                    topicType = t.optString("type", "TOPIC").ifEmpty { "TOPIC" },
                                    coverFileId = null,
                                    backgroundFileId = null,
                                    coverCrop = null,
                                    peopleIds = peopleIds,
                                    fileIds = emptyList(),
                                    sourceUrl = null,
                                    createdAt = now,
                                    updatedAt = now,
                                    sourceType = null,
                                    workName = null,
                                    workNameCn = null,
                                    fileCount = 0,
                                ),
                            )
                            topicsAdded++
                        }
                    }
                    "已导入：词表 +$tagsAdded，人物 +$peopleAdded，专题 +$topicsAdded"
                } catch (e: Exception) {
                    Log.w("AuroraKotlin", "[Settings] import backup failed", e)
                    "导入失败（格式或读取错误）"
                }
            }
            if (report.startsWith("已导入")) viewModel.refreshTagSnapshots()
            Toast.makeText(this@MainActivity, report, Toast.LENGTH_LONG).show()
        }
    }

    /** 备份导出（2.3，字段对齐 React StoragePanel 导出：词表 + 人物 + 简化专题）。 */
    private fun exportBackup() {
        lifecycleScope.launch {
            val json = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val grouped = uniffi.aurora_core.getGroupedTags(viewModel.settings.value.language)
                val tags = grouped.flatMap { g -> g.tags.map { it.tag } }
                val people = uniffi.aurora_core.getAllPeople()
                val topics = uniffi.aurora_core.getAllTopics()
                val peopleJson = org.json.JSONObject()
                people.forEach { p ->
                    peopleJson.put(
                        p.id,
                        org.json.JSONObject()
                            .put("name", p.name)
                            .put("description", p.description ?: JSONObject.NULL)
                            .put("count", p.count),
                    )
                }
                val topicsJson = org.json.JSONObject()
                topics.forEach { t ->
                    topicsJson.put(
                        t.id,
                        org.json.JSONObject()
                            .put("id", t.id)
                            .put("name", t.name)
                            .put("parentId", t.parentId ?: JSONObject.NULL)
                            .put("description", t.description ?: JSONObject.NULL)
                            .put("type", t.topicType ?: "TOPIC")
                            .put("peopleIds", org.json.JSONArray(t.peopleIds)),
                    )
                }
                org.json.JSONObject()
                    .put("tags", org.json.JSONArray(tags))
                    .put("people", peopleJson)
                    .put("topics", topicsJson)
                    .toString(2)
            }
            try {
                val fileName = "aurora_metadata_backup_${java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())}.json"
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/json")
                    if (Build.VERSION.SDK_INT >= 29) {
                        put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/")
                        put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
                    }
                }
                val collection = if (Build.VERSION.SDK_INT >= 29) {
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI
                } else {
                    Uri.parse("${android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)}/$fileName")
                }
                val uri = contentResolver.insert(collection, values)
                    ?: throw IllegalStateException("insert failed")
                contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(json.toByteArray())
                } ?: throw IllegalStateException("openOutputStream failed")
                if (Build.VERSION.SDK_INT >= 29) {
                    contentResolver.update(uri, android.content.ContentValues().apply {
                        put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                    }, null, null)
                }
                Toast.makeText(this@MainActivity, "已导出到 Download/$fileName", Toast.LENGTH_LONG).show()
            } catch (e: Exception) {
                Log.w("AuroraKotlin", "[Settings] export backup failed", e)
                Toast.makeText(this@MainActivity, "导出失败", Toast.LENGTH_SHORT).show()
            }
        }
    }
    // —— M4b 1.4/1.3 复制/移动/重命名的宿主执行（网格与查看器共用一条写入路径）——
    // 弹窗层状态（目标选择器/合并确认/重命名目标）在 App() 组合里；这里只提供
    // 「已确定目标后的执行」：解析 RELATIVE_PATH、批量授权、调写原语、反馈。

    /** 复制/移动到既有相册（folderId 现场解析 RELATIVE_PATH）。 */
    private fun performCopyMoveToFolder(
        fileIds: List<String>,
        targetFolderId: String,
        type: String,
        onFinished: () -> Unit = {},
    ) {
        viewModel.resolveFolderRelPath(targetFolderId) { relPath ->
            if (relPath == null) {
                Toast.makeText(this, "无法解析目标相册路径", Toast.LENGTH_SHORT).show()
                return@resolveFolderRelPath
            }
            performCopyMove(fileIds, relPath, type, onFinished)
        }
    }

    /** 复制/移动到**新相册**（1.3 懒创建：RELATIVE_PATH 指向 `Pictures/<名字>`，落地文件才产生 Folder 行）。 */
    private fun performCopyMoveToNewAlbum(
        fileIds: List<String>,
        albumName: String,
        type: String,
        onFinished: () -> Unit = {},
    ) {
        if (albumName.isEmpty() || albumName == "." || albumName == ".." ||
            albumName.contains('/') || albumName.contains('\\')
        ) {
            Toast.makeText(this, "相册名不能包含 / \\ 等路径字符", Toast.LENGTH_SHORT).show()
            return
        }
        performCopyMove(fileIds, "Pictures/$albumName", type, onFinished)
    }

    private fun performCopyMove(
        fileIds: List<String>,
        relPath: String,
        type: String,
        onFinished: () -> Unit = {},
    ) {
        viewModel.resolveFileUris(fileIds) { uris ->
            // M4b 诊断日志：fileId 与 uri 的对应关系是「移错文件」类问题的第一现场
            Log.w("AuroraFileOp", "performCopyMove type=$type relPath=$relPath ids=$fileIds uris=$uris")
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可操作的文件", Toast.LENGTH_SHORT).show()
                return@resolveFileUris
            }
            val report: (Int) -> Unit = { n ->
                Toast.makeText(
                    this,
                    when {
                        n == 0 -> if (type == "copy") "复制失败" else "移动失败"
                        else -> (if (type == "copy") "已复制 " else "已移动 ") + "$n 张"
                    },
                    Toast.LENGTH_SHORT,
                ).show()
                if (n > 0) onFinished()
            }
            if (type == "copy") {
                // 复制静默完成（insert 新行只要读权限，规划五要点②的不对称）
                viewModel.copyFiles(uris, relPath, report)
            } else {
                // 移动改 RELATIVE_PATH：直写 + 被拦时授权一次后重试（慢图浏览同款）
                viewModel.moveFiles(
                    uris,
                    relPath,
                    report,
                    writeConsentFor { blocked -> opJson("move", blocked).put("relPath", relPath) },
                )
            }
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
        // 沉浸态的系统栏/窗口色接管：查看器只发「进/出」，动 flags 与色值一律在宿主
        it.onImmersiveBarsChange = { hidden -> setViewerImmersiveBars(hidden) }
        viewer = it
    }

    // —— 查看器进出过渡（2026-10-08）：网格卡片 ⇄ 全屏图，贝塞尔节奏的放大/收缩 ——

    /**
     * 覆盖层挂在 `android.R.id.content` 的**末尾**：它是 ComposeView（以及 M8b-15 那层 pre-IME
     * 拦截壳）的兄弟节点且在其后，所以同一段动画能同时盖住网格层与查看器层——这两层在
     * Compose 里是父子 Box，从组合内部没法把动画画到它们之上。
     */
    private val viewerTransition: ViewerTransition by lazy {
        ViewerTransition(findViewById(android.R.id.content))
    }

    /** 退出动画落点的查询通道：由当前存活的那个 [FileGrid] 注册（见 PhotoRectQuery）。 */
    private val viewerPhotoRectQuery = PhotoRectQuery()

    /**
     * 进入动画的起点快照（fileId + 当时的封面矩形，窗口坐标）。
     *
     * 退出时先按 fileId 回查网格**当前**可见矩形（用户可能翻过页、网格也可能滚过），
     * 查不到才退回这份快照——而且只在它仍对应同一张图时用，否则会把图飞回另一张卡片上。
     */
    private var viewerEnterAnchor: Pair<String, RectF>? = null

    /** 内容根（覆盖层所在的容器）在窗口坐标系里的矩形；过渡动画的坐标都从这里起算。 */
    private fun contentWindowRect(): RectF? =
        viewerTransition.windowRectOf(findViewById<ViewGroup>(android.R.id.content))

    /**
     * 进入动画的预测落点：按库里记的宽高把图 fit-center 到整个窗口。
     *
     * 只是**兜底**。真图一上屏，覆盖层就逐帧改用实测矩形（`ViewerTransition.liveEnd`），
     * 因为元数据的宽高可能被 EXIF 旋转反过来，纯预测会落歪、揭幕那一帧会看到图跳一下。
     */
    private fun predictedViewerRect(image: Image): RectF? {
        val win = contentWindowRect() ?: return null
        val iw = image.width?.toInt() ?: 0
        val ih = image.height?.toInt() ?: 0
        // 元数据没记宽高（个别 LAN/异常行）：先按整屏铺，真图上屏后由实测矩形改写
        if (iw <= 0 || ih <= 0) return win
        val s = kotlin.math.min(win.width() / iw, win.height() / ih)
        val w = iw * s
        val h = ih * s
        val left = win.left + (win.width() - w) / 2f
        val top = win.top + (win.height() - h) / 2f
        return RectF(left, top, left + w, top + h)
    }

    /**
     * 从网格点开一张图：先只起覆盖层的展开动画，**查看器等展开到位再挂载**。
     *
     * 为什么不当场挂载：写「打开查看器」状态 = 一次 Compose 重组 + 挂载整棵查看器视图树 +
     * `open()`（缩略图条 submit、抽屉重建、发图、首轮 measure/layout），全是主线程同步活。
     * 模拟器实测这一段 190ms、真机更长——压在 320ms 的展开动画里，动画就只剩两三帧，
     * 用户看到的就是「点一下，图跳一下变大」（真机报障原话：只有 2 个阶段）。错开之后同样
     * 的开销藏在覆盖层那张已经放大到位的图底下，一帧不丢。
     */
    private fun openViewerFromGrid(image: Image, cover: ImageView) {
        val view = ensureViewer()
        val predicted = predictedViewerRect(image)
        // 起点快照：退出时网格查不到落点的兜底（只在 fileId 还对得上时用）
        viewerEnterAnchor = viewerTransition.windowRectOf(cover)?.let { image.id to it }
        val started = predicted != null && viewerTransition.startEnter(
            cover = cover,
            scrimColor = view.transitionScrimColor(),
            predictedEnd = predicted,
            liveEnd = { out -> view.currentImageRect(out) },
            onExpansionDone = { mountViewer(view, image.id) },
            onReveal = { view.revealAfterTransition() },
        )
        if (started) {
            armPendingOpenGuard()
        } else {
            view.holdHiddenForTransition = false
            viewModel.appState.openViewer(image.id)
        }
    }

    /** 展开到位：这一刻才真正挂载查看器（先置挂起位，[NativeGalleryView.open] 读它）。 */
    private fun mountViewer(view: NativeGalleryView, fileId: String) {
        disarmPendingOpenGuard()
        view.holdHiddenForTransition = true
        viewModel.appState.openViewer(fileId)
    }

    /**
     * 展开窗口期（查看器还没挂载、`viewingFileId` 还是空）的返回拦截。
     *
     * 不拦的话这 320ms 里按返回会落到网格那条 4.3 导航链上——退掉当前文件夹，然后回调照跑、
     * 查看器在别的视图上冒出来。拦下来 = 撤回这次「点开」，覆盖层无声退场，屏幕回到点之前。
     */
    private var pendingOpenGuard: OnBackPressedCallback? = null

    private fun armPendingOpenGuard() {
        disarmPendingOpenGuard()
        pendingOpenGuard = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                viewerTransition.cancel()
                disarmPendingOpenGuard()
            }
        }.also { onBackPressedDispatcher.addCallback(it) }
    }

    private fun disarmPendingOpenGuard() {
        pendingOpenGuard?.remove()
        pendingOpenGuard = null
    }

    /**
     * 退出：图片缩回网格卡片，动画跑完才真的关查看器、收组合层。
     *
     * 落点三级：① 网格当前可见的同 id 卡片；② 进入时那份起点快照（仍对应同一张才用）；
     * ③ 都没有 = 缩到窗口中央并淡出（用户翻过页、网格滚过之后就是这个，比硬切有交代，
     * 也不会飞到一个编出来的位置上）。
     */
    private fun closeViewerWithTransition(view: NativeGalleryView) {
        // 已经有一段在跑：先把它跑完（进入=揭幕、退出=真关），再决定要不要接着做退出动画。
        // 连点两次返回 = 第二段直接落定，不并发起第二个覆盖层，也不把同一段收尾跑两遍。
        if (viewerTransition.isRunning) {
            viewerTransition.finishNow()
            if (!view.isOpen()) return
        }
        val fileId = view.transitionFileId()
        val drawable = view.currentImageDrawable()
        val start = RectF()
        if (fileId == null || drawable == null || !view.currentImageRect(start)) {
            closeViewerNow(view)
            return
        }
        val target = RectF()
        var anchored = viewerPhotoRectQuery.query?.invoke(fileId, target) == true
        if (!anchored) {
            val anchor = viewerEnterAnchor
            if (anchor != null && anchor.first == fileId && anchor.second.width() > 0f) {
                target.set(anchor.second)
                anchored = true
            }
        }
        if (!anchored) {
            val win = contentWindowRect()
            if (win == null) {
                closeViewerNow(view)
                return
            }
            val w = (start.width() * 0.35f).coerceAtLeast(1f)
            val h = (start.height() * 0.35f).coerceAtLeast(1f)
            val cx = win.centerX()
            val cy = win.centerY()
            target.set(cx - w / 2f, cy - h / 2f, cx + w / 2f, cy + h / 2f)
        }
        view.hideForTransition()
        val started = viewerTransition.startExit(
            startRect = start,
            drawable = drawable,
            endRect = target,
            scrimColor = view.transitionScrimColor(),
            fadeImage = !anchored,
            onFinish = { closeViewerNow(view) },
        )
        if (!started) {
            // 覆盖层没起来（系统「移除动画」被打开等）：可见性得自己补回来再硬关，
            // 否则整层停在 INVISIBLE，而动画永远不会来揭幕
            view.visibility = View.VISIBLE
            closeViewerNow(view)
        }
    }

    private fun closeViewerNow(view: NativeGalleryView) {
        view.close()
        viewModel.appState.closeViewer()
    }

    private fun viewerListener(view: NativeGalleryView) = object : NativeGalleryView.Listener {
        override fun onClose(animate: Boolean) {
            // 用户主动退出 = 图片缩回网格卡片（2026-10-08）；animate=false 是删除/移出到空之后
            // 的连带关闭，那张图在网格里已经没了，直接硬关。
            if (animate) closeViewerWithTransition(view) else closeViewerNow(view)
        }

        /**
         * 3.3：翻页跟到当前这张。不回写的话转屏重建 Activity 后会回到「进入时那张」，
         * 而不是用户正在看的那张。
         * M6b 阶段 3：自动提取触发点——开关开且当前图未提取（缓存无记录）时后台提取，
         * 成败都经 [applyPaletteResult] 回填（成功塞色块、失败置手动重试按钮），无 Toast。
         */
        override fun onNavigate(index: Int) {
            val fileId = view.fileIdAt(index) ?: return
            viewModel.appState.viewerNavigated(fileId)
            maybeAutoExtractPalette(fileId)
        }

        /**
         * 3.2 删除：查看器自己已经把这张从它的序列里摘掉并前进到下一张（confirmDelete），
         * 宿主只负责发起真正的删除请求。确认弹窗是查看器内的 `DeleteConfirmDialog`
         * （与网格 4.2 的应用内确认同一形态），不走 [onDeleteSelection] 那条网格链路。
         * 本地的删完对账交给既有 ContentObserver 重扫。
         * M6a 阶段 6：[isLan] 分流远端链路——单张就是一个元素的批次走
         * [GalleryViewModel.deleteLanFiles]（数据层顺带维护会话缓存 + 重拉），Toast
         * 口径与网格批量删除一致；入口显隐由查看器按 lanAllowEdit 门禁（阶段 4 的
         * 「删除归阶段 6」占位由此兑现）。
         */
        override fun onDelete(fileId: String, isLan: Boolean) {
            if (isLan) {
                viewModel.deleteLanFiles(listOf(fileId)) { ok, fail ->
                    Toast.makeText(
                        this@MainActivity,
                        when {
                            fail == 0 -> "已删除 $ok 张"
                            ok == 0 -> "删除失败"
                            else -> "已删除 $ok 张，失败 $fail 张"
                        },
                        Toast.LENGTH_SHORT,
                    ).show()
                }
                return
            }
            viewModel.resolveSelectionUris(setOf(fileId)) { uris -> requestDelete(uris) }
        }

        /** 3.2 分享：单图版，复用网格那套 ACTION_SEND_MULTIPLE。 */
        override fun onShare(filePath: String) {
            if (filePath.isEmpty()) {
                // 防御分支（正常路径 filePath 恒非空）；文件操作归 M4b
                toastSoon("分享", "M4b")
                return
            }
            shareUris(listOf(Uri.parse(filePath)))
        }

        /** 3.3：幻灯片配置查看器已就地生效（能播、能设间隔），M3 没有设置持久层可写。 */
        override fun onUpdateSlideshowConfig(configJson: String) {
            Log.i("AuroraViewer", "slideshow config applied: $configJson")
        }

        // —— 以下入口的能力归属已按 M4 拆分重标（M4a 4.3）：查看器的复制/移动走
        // MediaStore（M4b 1.5 已落地）；颜色/主色调链路归 M6；onMore/onEditTags/
        // onLongPress 三个死回调已随 6.1 收口从 Listener 删除——

        /**
         * M4a 2.1：查看器三个编辑弹窗的落库分支。键与语义见
         * [NativeGalleryView.Listener.onUpdateFile] 的契约注释。
         *
         * 本方法是「查看器协议 → 数据层」的唯一适配点：解析在这里做，落库与快照重算在
         * [GalleryViewModel.saveFileUpdates]，元数据面板（4.2）直接调后者、不经过这里。
         *
         * M6a 阶段 5：[isLan] 分支是 D31 数据层铁律的守门员——远端项的编辑永远走
         * [GalleryViewModel.saveLanFileUpdates]（LanClient 回写桌面），绝不落本地 FFI；
         * 键存在才传、缺省=null=不改（对齐契约 §2.2 的 patch 语义）。
         */
        override fun onUpdateFile(fileId: String, updatesJson: String, isLan: Boolean) {
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
            // P1(b) 多值：查看器现在只发 sourceUrls（整体覆盖，空数组 = 清空）；
            // sourceUrl 单值键仍认，供旧调用点/后续手动构造的 JSON。
            val sourceUrls = updates.optJSONArray("sourceUrls")?.let { arr ->
                List(arr.length()) { arr.getString(it) }
            }
            if (tags == null && description == null && sourceUrl == null && sourceUrls == null) {
                // 走到这里的实际只有 `{"name": …}`（查看器的重命名弹窗）：重命名改的是
                // MediaStore 的 DISPLAY_NAME（M4b 1.5 接通写原语，直写、被拦才要授权），
                // 元数据行挂在同一 file_id 上不动（规划五要点②）。查看器已就地更新了
                // 自己列表里的名字，失败时靠重扫对账纠正。
                if (isLan) {
                    // 防御：LAN 项的重命名入口已双重不可达（菜单不含 + showRenameDialog
                    // 护栏），真到了这里也不能把远端 path 写进本地 MediaStore。
                    Log.w("AuroraKotlin", "[Edit] LAN 项的重命名请求被拦截（理论不可达）: $fileId")
                    return
                }
                val newName = updates.optString("name")
                if (newName.isNotEmpty()) {
                    withResolvedUris(listOf(fileId)) { uris ->
                        viewModel.renameFiles(
                            listOf(uris.first() to newName),
                            onDone = { n ->
                                if (n == 0) {
                                    Toast.makeText(this@MainActivity, "重命名失败", Toast.LENGTH_SHORT).show()
                                }
                            },
                            onBlocked = writeConsentFor { blocked ->
                                opJson("rename", blocked).put(
                                    "targets",
                                    JSONArray(blocked.map { JSONArray(listOf(it.toString(), newName)) }),
                                )
                            },
                        )
                    }
                }
                return
            }
            if (isLan) {
                // D31 守门员分支：LAN 项的标签/描述/来源回写远端桌面库（allow_edit 关闭
                // 时数据层回 false →「保存失败」），不碰本地词表/本地过滤。
                viewModel.saveLanFileUpdates(fileId, tags, description, sourceUrl, sourceUrls) { ok ->
                    Toast.makeText(
                        this@MainActivity,
                        if (ok) "已保存" else "保存失败",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
                return
            }
            viewModel.saveFileUpdates(fileId, tags, description, sourceUrl, sourceUrls) { ok ->
                if (!ok) Toast.makeText(this@MainActivity, "保存失败", Toast.LENGTH_SHORT).show()
            }
        }

        override fun onColorSearch(colorHex: String) {
            viewModel.startColorSearch(colorHex)
        }

        override fun onExtractPalette(fileId: String, filePath: String) {
            viewModel.extractPalette(fileId, filePath) { hexes ->
                applyPaletteResult(fileId, hexes, silent = false)
            }
        }

        /** M6b 阶段 2：查看器「更多 → AI 分析」（本地项；LAN 项菜单不出现该条）。 */
        override fun onAiAnalyze(fileId: String) {
            viewModel.startAiAnalysis(listOf(fileId))
        }

        /** M6b 阶段 5（D36）：以图搜图——本地图字节 → 桌面 CLIP → 命中进 LAN 搜索结果视图。 */
        override fun onFindSimilar(fileId: String) {
            viewModel.findSimilarOnDesktop(fileId) { ok ->
                if (!ok) {
                    Toast.makeText(
                        this@MainActivity,
                        "未找到相似图（需连接桌面端且模型/索引就绪）",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }

        /** M4b 1.5：查看器「更多」的复制/移动 → FolderPickerDialog（folderTree 从 VM 快照构造）。 */
        override fun onCopyToFolder(fileId: String) {
            view.showFolderPickerDialog("copy", fileId, folderTreeJson()) { name ->
                onViewerNewAlbum(fileId, name, "copy")
            }
        }

        override fun onMoveToFolder(fileId: String) {
            view.showFolderPickerDialog("move", fileId, folderTreeJson()) { name ->
                onViewerNewAlbum(fileId, name, "move")
            }
        }

        /**
         * M4b 1.5：查看器弹窗确认（1.4 的 onFolderPickerConfirm 从 Toast 改为真执行；
         * move 时查看器自己已把这张从序列里摘掉，宿主只管落库，失败靠重扫对账纠正）。
         */
        override fun onFolderPickerConfirm(fileId: String, targetFolderId: String, type: String) {
            performCopyMoveToFolder(listOf(fileId), targetFolderId, type)
        }

        /** M5 3.2：查看器「加入画布」（仅平板菜单可达；FFI 解析宽高 → 装箱落 store）。 */
        override fun onAddToCanvas(fileId: String) {
            viewModel.canvasSourcesFor(listOf(fileId)) { sources ->
                when (val r = viewModel.canvasStore.addImages(sources)) {
                    is AddResult.Added -> Toast.makeText(
                        this@MainActivity,
                        "已加入画布（${viewModel.canvasStore.count}/24）",
                        Toast.LENGTH_SHORT,
                    ).show()
                    AddResult.AllDuplicates -> Toast.makeText(
                        this@MainActivity, "这张已在画布中", Toast.LENGTH_SHORT,
                    ).show()
                    AddResult.Full -> Toast.makeText(
                        this@MainActivity, "画布已满（24/24）", Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }

        /**
         * M6a 阶段 4（D34）：查看器「保存到设备」（仅 LAN 项的菜单项）。
         * VM 下载原文件 → MediaStore Downloads insert；重名自动序号，成功 Toast 带落定名。
         */
        override fun onSaveToDevice(remotePath: String, imageUrl: String) {
            Toast.makeText(this@MainActivity, "正在保存到设备…", Toast.LENGTH_SHORT).show()
            viewModel.saveLanImageToDownloads(remotePath, imageUrl) { ok, savedName ->
                Toast.makeText(
                    this@MainActivity,
                    if (ok) "已保存到下载${savedName?.let { "：$it" } ?: ""}" else "保存失败",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    /** FolderPickerDialog 的 folderTreeJson：Kotlin 侧是扁平 bucket 列表（D18），全为根节点。 */
    private fun folderTreeJson(): String {
        val folders = viewModel.folders.value
        val folderArr = org.json.JSONArray()
        val roots = org.json.JSONArray()
        folders.forEach { f ->
            roots.put(f.id)
            folderArr.put(
                org.json.JSONObject()
                    .put("id", f.id)
                    .put("name", f.name)
                    .put("parentId", JSONObject.NULL)
                    .put("children", org.json.JSONArray()),
            )
        }
        return org.json.JSONObject()
            .put("roots", roots)
            .put("folders", folderArr)
            .toString()
    }

    /**
     * 查看器侧「+ 新建相册」（M4b 1.3，与网格侧同一语义）：重名 → View 体系的合并确认
     * （D13：弹窗两处实现、写入路径只有一条）；不重名 → 校验后建在 Pictures/<名字>。
     */
    private fun onViewerNewAlbum(fileId: String, albumName: String, type: String) {
        val existing = viewModel.folders.value.firstOrNull { it.name == albumName }
        if (existing != null) {
            android.app.AlertDialog.Builder(this)
                .setTitle("合并到已有相册")
                .setMessage("已有同名相册「${existing.name}」（${existing.imageCount} 张）。将把所选文件并入该相册。")
                .setPositiveButton("并入") { d, _ ->
                    d.dismiss()
                    performCopyMoveToFolder(listOf(fileId), existing.id, type)
                }
                .setNegativeButton("取消", null)
                .show()
            return
        }
        performCopyMoveToNewAlbum(listOf(fileId), albumName, type)
    }

    /** 未落地能力的可见占位（M3 3.3：静默无响应在真机上会被当成 bug 报回来）。 */
    private fun toastSoon(feature: String, milestone: String) {
        Toast.makeText(this, "$feature 将随 $milestone 提供", Toast.LENGTH_SHORT).show()
    }

    // —— M6b 阶段 3：主色调提取回填与自动提取 ——

    /**
     * 自动提取的守门：开关开 + 颜色缓存无记录 + 本地 content URI（LAN 项的颜色键
     * 不存在，Section 4 已在查看器侧隐藏，这里只是兜底）。静默模式：失败只置
     * paletteLoadFailed 让抽屉退回手动按钮，不弹 Toast。
     */
    private fun maybeAutoExtractPalette(fileId: String) {
        if (!viewModel.settings.value.autoExtractPalette) return
        if (viewModel.colorPalettesById.value.containsKey(fileId)) return
        val uri = contentUriOf(fileId) ?: return
        if (!uri.startsWith("content:")) return
        viewModel.extractPalette(fileId, uri) { hexes ->
            applyPaletteResult(fileId, hexes, silent = true)
        }
    }

    /** 查看器当前序列可能的三个数据源里找 contentUri（普通视图/颜色搜索/AI 搜索命中序列）。 */
    private fun contentUriOf(fileId: String): String? =
        viewModel.images.value.firstOrNull { it.id == fileId }?.contentUri
            ?: viewModel.colorSearchResultImages.value.firstOrNull { it.id == fileId }?.contentUri
            ?: viewModel.aiSearchResultImages.value?.firstOrNull { it.id == fileId }?.contentUri

    /**
     * 提取结果回填查看器（手动与自动共用）：成功塞 palette（抽屉清 loading 显示色块），
     * 失败置 paletteLoadFailed（自动提取退回「提取主色调」按钮，手动加 Toast）。
     */
    private fun applyPaletteResult(fileId: String, hexes: List<String>?, silent: Boolean) {
        val view = viewer ?: return
        val json = org.json.JSONObject()
        if (hexes != null) {
            json.put("palette", org.json.JSONArray(hexes))
        } else {
            json.put("paletteLoadFailed", true)
            if (!silent) Toast.makeText(this, "主色调提取失败", Toast.LENGTH_SHORT).show()
        }
        view.updateItem(fileId, json)
    }

    /**
     * 全屏面（画布）的系统栏接管：进入=隐藏、退出=还原。**仅画布使用**——查看器的沉浸
     * 态走 [setViewerImmersiveBars]（同一套 flags，但额外管窗口黑底）。
     */
    private var savedSystemUiVisibility: Int? = null

    /** 查看器是否已把状态栏藏进沉浸态（[setViewerImmersiveBars] 的幂等/重申依据）。 */
    private var viewerBarsHidden = false

    /** API<30 用：沉浸隐藏状态栏前的系统 UI 位（还原回写它，不用 0——0 会清掉别处设的 LAYOUT 位）。 */
    private var savedViewerImmersiveUiVisibility: Int? = null

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
    private fun setViewerImmersiveBars(hidden: Boolean) {
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

    private fun setViewerSystemBars(hidden: Boolean) {
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
    private fun isDarkTheme(): Boolean = when (viewModel.settings.value.theme) {
        AppSettings.THEME_DARK -> true
        AppSettings.THEME_LIGHT -> false
        else -> systemDark
    }

    private fun isSystemDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        systemDark =
            (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        // 旋转/分屏会翻转 compact 判定：手机向导（蓝状态栏）↔ 平板向导/主界面（主题色
        // 状态栏）的窗口色要跟着重涂；无向导时重写同值，幂等无害。
        applyWindowTheme(isDarkTheme())
    }

    /**
     * 窗口层主题同步（M4c）：窗口底色 = palette.content——edge-to-edge 下系统栏镂空区露的
     * 也是这层；statusBarColor 在 API 35+ 被 edge-to-edge 忽略，低版本写它对齐观感。状态栏
     * 图标深浅随档切。SideEffect 每次重组幂等重写。2026-10-07 会话模型后色值全程归本函数
     * 管（系统栏接管只动 flags，不再写任何色值）。
     */
    private fun applyWindowTheme(dark: Boolean) {
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

    /** 应用版本（关于页显示，M4c）：PackageManager 取 versionName，失败退空串。 */
    private val appVersion: String by lazy {
        try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    /** 关于页外链（GitHub/Issues，M4c）：系统浏览器打开；无浏览器等失败仅提示。 */
    private fun openExternalUrl(url: String) {
        runCatching {
            startActivity(
                android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)),
            )
        }.onFailure {
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        viewer?.destroy()
        viewer = null
        super.onDestroy()
    }

    // —— M4b 1.4 排查：确认触摸事件是否进入应用（收口时删）——
    override fun dispatchTouchEvent(ev: android.view.MotionEvent): Boolean {
        if (ev.action == android.view.MotionEvent.ACTION_DOWN) {
            Log.i("AuroraMenu", "dispatch DOWN x=${ev.x.toInt()} y=${ev.y.toInt()}")
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 删除的「先写后授权」兜底（rename/move 的删源阶段也复用）：直删被系统拦下时
        // 发 createDeleteRequest——已开「管理媒体」时系统不弹窗直接执行，结果经
        // deleteLauncher 回来调 retry（重删幂等，见 GalleryViewModel.deleteConsentFallback）。
        viewModel.deleteConsentFallback = { blocked, retry ->
            if (Build.VERSION.SDK_INT >= 30) {
                try {
                    pendingDeleteRetry = retry
                    val pi = MediaStore.createDeleteRequest(contentResolver, blocked)
                    deleteLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
                } catch (e: Exception) {
                    pendingDeleteRetry = null
                    Log.w("AuroraKotlin", "[Delete] createDeleteRequest failed", e)
                    Toast.makeText(this, "删除请求失败", Toast.LENGTH_SHORT).show()
                }
            } else {
                // Q 上没有 createDeleteRequest（该引用在 targetSdk < 30 下若执行会
                // NoSuchMethodError）；删除被拦只能放弃。当前所有删除入口都经带版本
                // 守卫的 requestDelete，这条默认兜底链无调用点，防御性收尾而已。
                pendingDeleteRetry = null
            }
        }

        // M4c 主题生效链的源头：先取系统深浅档（"system" 用），再按设置档把窗口底色
        // 在首帧前上好——深色档冷启动不闪白。
        systemDark = isSystemDark()
        applyWindowTheme(isDarkTheme())

        setContent {
            // 主题档由设置驱动（M4c，D23）：settings.theme 直接选档，"system" 跟随
            // [systemDark]。XML 主题（Theme.AuroraKotlin = Material.Light）只作进程兜底，
            // 运行期窗口底色/状态栏外观经 [applyWindowTheme] 与调色板同步；网格与查看器
            // 同读一张 AuroraPalette（FileGrid 走 Compose 注入色 + applyThemeColors 重绑，
            // 查看器经 applyViewerTheme 下次 open 生效、已开着由 applyThemeNow 即时重涂
            // ——M8b 阶段 3）。取代 M1 的「固定浅色 + XML 必须
            // 一致」约束——那约束防的「深调色板画在白窗底」现在由窗口底色同步根除。
            val dark = isDarkTheme()
            AuroraTheme(darkTheme = dark) {
                SideEffect {
                    applyWindowTheme(dark)
                    applyViewerTheme(dark)
                    // M8b 阶段 3（遗留 #5，D26 登记项销账）：查看器开着切主题即时换色——
                    // 实例未创建或未打开时内部短路（存档即可，open 时仍走 options 重放）。
                    viewer?.takeIf { it.isOpen() }?.applyThemeNow(dark)
                }
                val appState = viewModel.appState
                val tab = appState.activeTab
                // M6a 阶段 3：LAN 连接快照（侧栏网络 Section 的状态来源；collect 成普通值传入）
                val lanSnapshot by viewModel.lan.snapshot.collectAsState()
                // 当前该显示哪批图（文件夹 / 标签命中 / 专题成员）：导航与标签筛选都收敛到
                // 这一个触发点。协程随 key 变化自动取消，所以「点进 B 还没查完」不会把 A
                // 的结果盖上去——旧 openFolder 里手写的竞态守卫由结构化并发兜住了。
                LaunchedEffect(tab.viewMode, tab.folderId, tab.activeTags, tab.activeTopicId) {
                    viewModel.reloadImages()
                }
                // M6b 阶段 3：颜色库暖缓存（启动一次批读全库已提取主色调，抽屉色块预填）
                LaunchedEffect(Unit) {
                    viewModel.refreshPaletteCache()
                }
                // D50：启动自动更新检查（内部 24h 节流；命中新版本时下方 UpdateDialog 弹出）
                LaunchedEffect(Unit) {
                    viewModel.updateController.check()
                }
                // M6b 阶段 2：AI 搜索态清理——清词/关搜索即弃命中集，回到普通文本过滤
                LaunchedEffect(tab.searchQuery) {
                    if (tab.searchQuery.isBlank()) {
                        viewModel.clearAiSearch()
                        viewModel.clearColorSearch()
                        viewModel.clearLanSearch()
                    }
                }
                // 展示序列在这一层求值，网格与查看器共用同一个结果（2.2：进入的 startIndex
                // 必须落在过滤后的序列上，两处各算一遍会有漂移风险）。M4b 阶段 3 起
                // scope 文本搜索的数据源（标签/元数据快照 + 所属文件夹名）一并喂入。
                val currentFolderName = appState.activeTab.folderId?.let { id ->
                    viewModel.folders.value.firstOrNull { it.id == id }?.name
                }.orEmpty()
                // M6b 阶段 2/3：AI 搜索或颜色搜索的命中集数据源切换——全库命中序列顶替
                // 当前文件夹序列（两者互斥，VM 内发起一方即清另一方）。
                val aiSearchActive = viewModel.aiSearchIds.value != null
                val colorSearchActive = viewModel.colorSearchIds.value != null
                val displayImages = rememberDisplayImages(
                    when {
                        aiSearchActive -> viewModel.aiSearchResultImages.value.orEmpty()
                        colorSearchActive -> viewModel.colorSearchResultImages.value
                        else -> viewModel.images.value
                    },
                    appState.activeTab,
                    appState.sortBy,
                    appState.sortDirection,
                    tagsByFile = viewModel.tagsByFile.value,
                    metadataById = viewModel.metadataById.value,
                    viewFolderName = currentFolderName,
                    // M6b 阶段 2/3：AI 命中集与颜色命中集共用同一过滤分支（null=普通过滤）
                    aiFilterIds = viewModel.aiSearchIds.value ?: viewModel.colorSearchIds.value,
                )
                val imagesPending = viewModel.imagesPending.value
                // 组合根**不吃** insets：查看器要真全屏——若它挂在带 statusBarsPadding
                // 的容器里，沉浸隐藏系统栏时 padding 归零→容器变高→图片重居中→「图片
                // 位置上下变动」。主内容另套一层吃 statusBarsPadding，观感与旧版一致；
                // 查看器则在本层铺满窗口，翻转系统栏零 resize（2026-10-07 B2 定稿）。
                Box(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().statusBarsPadding()) {
                    App(
                        state = appState,
                        darkTheme = dark,
                        canvasStore = viewModel.canvasStore,
                        folders = viewModel.folders.value,
                        localCoverOverrides = viewModel.localCoverOverrides.value,
                        // 2026-10-08 文件夹活动时间（总览 date 排序键 = max(内容最新, 活动)）
                        folderActivityAt = viewModel.folderActivityAt.value,
                        images = viewModel.images.value,
                        displayImages = displayImages,
                        imagesPending = imagesPending,
                        tagGroups = viewModel.tagGroups.value,
                        topics = viewModel.topics.value,
                        coverImagesById = viewModel.coverImagesById.value,
                        scanning = viewModel.scanning.value,
                        thumbnailLoader = viewModel.thumbnailLoader,
                        // 2026-10-08 查看器进出过渡：开图走带覆盖层的那条路，落点通道交给网格注册
                        onOpenViewer = ::openViewerFromGrid,
                        viewerPhotoRectQuery = viewerPhotoRectQuery,
                        // M6a 阶段 3：LAN 连接快照（网络 Section）
                        lanSnapshot = lanSnapshot,
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
                        /** 4.2 删除：解析选中项为 URI 后由宿主发起删除请求（含系统确认）。
                         *  M6a 阶段 6 起 LAN 态不进这条链路（App 内按 inLanBrowser 分流到
                         *  [onDeleteLanSelection]，远端 path 过 MediaStore 解析必空）。 */
                        onDeleteSelection = { ids ->
                            viewModel.resolveSelectionUris(ids) { uris ->
                                if (uris.isNotEmpty()) requestDelete(uris)
                            }
                        },
                        // —— M4a 4.3 长按菜单的标签三项（数据在 VM 快照，落库走唯一写入口）——
                        tagsByFile = viewModel.tagsByFile.value,
                        onCopyTags = { ids ->
                            val merged = LinkedHashSet<String>()
                            ids.forEach { id -> viewModel.tagsByFile.value[id]?.let(merged::addAll) }
                            viewModel.appState.copiedTags = merged
                            Toast.makeText(
                                this@MainActivity,
                                if (merged.isEmpty()) "所选图片没有标签" else "已复制 ${merged.size} 个标签",
                                Toast.LENGTH_SHORT,
                            ).show()
                        },
                        onPasteTags = { ids ->
                            if (viewModel.appState.copiedTags.isEmpty()) {
                                Toast.makeText(this@MainActivity, "剪贴板里还没有标签，先用「复制标签」复制一份", Toast.LENGTH_SHORT).show()
                            } else {
                                viewModel.pasteTagsToFiles(ids) { ok ->
                                    Toast.makeText(
                                        this@MainActivity,
                                        if (ok) "已粘贴标签" else "粘贴失败",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                }
                            }
                        },
                        onSaveFileTags = { fileId, tags ->
                            viewModel.saveFileUpdates(fileId, tags = tags) { ok ->
                                if (!ok) Toast.makeText(this@MainActivity, "保存失败", Toast.LENGTH_SHORT).show()
                            }
                        },
                        // —— M4a 4.3 专题长按菜单（重命名/删除）与详情「设为封面」——
                        onRenameTopic = { topic, name ->
                            viewModel.renameTopic(topic, name) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已重命名" else "重命名失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        onDeleteTopic = { topic ->
                            viewModel.deleteTopic(topic) { ok ->
                                if (ok) {
                                    // 删的是正在看的专题（总览里删根专题时 activeTopicId
                                    // 必为 null；详情里删的是子专题，不动 activeTopicId）
                                    if (appState.activeTab.activeTopicId == topic.id) {
                                        appState.updateActiveTab { it.copy(activeTopicId = null) }
                                    }
                                    Toast.makeText(this@MainActivity, "专题已删除", Toast.LENGTH_SHORT).show()
                                } else {
                                    Toast.makeText(this@MainActivity, "删除失败", Toast.LENGTH_SHORT).show()
                                }
                            }
                        },
                        onSetTopicCover = { topicId, fileId ->
                            viewModel.setTopicCover(topicId, fileId) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已设为封面" else "设置封面失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        // —— M4b 1.4/1.3 文件操作（弹窗在 App 内，执行在宿主）——
                        onCopyMoveFiles = { fileIds, folderId, type ->
                            performCopyMoveToFolder(fileIds, folderId, type) {
                                appState.exitSelectionMode()
                            }
                        },
                        onCopyMoveToNewAlbum = { fileIds, albumName, type ->
                            performCopyMoveToNewAlbum(fileIds, albumName, type) {
                                appState.exitSelectionMode()
                            }
                        },
                        onResolveSelectionFileIds = { ids, onReady ->
                            viewModel.resolveSelectionFileIds(ids, onReady)
                        },
                        onRenameFile = { fileId, newName ->
                            withResolvedUris(listOf(fileId)) { uris ->
                                viewModel.renameFiles(
                                    listOf(uris.first() to newName),
                                    onDone = { n ->
                                        Toast.makeText(
                                            this@MainActivity,
                                            if (n > 0) "已重命名" else "重命名失败",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                    },
                                    onBlocked = writeConsentFor { blocked ->
                                        opJson("rename", blocked).put(
                                            "targets",
                                            JSONArray(blocked.map { JSONArray(listOf(it.toString(), newName)) }),
                                        )
                                    },
                                )
                            }
                        },
                        // 普通设置入口：重置跳转落点（只有侧栏「网络」行会带 LAN）
                        onOpenSettings = { settingsInitialCategory = null; showSettings = true },
                        // 侧栏「网络」行未连接：开设置并落在局域网共享页（2026-09-26 验收反馈）
                        onLanSettingsClick = {
                            settingsInitialCategory = SettingsCategory.LAN
                            showSettings = true
                        },
                        // 侧栏「网络」行已连接：进 LAN 文件夹总览（2026-09-26 二轮反馈）
                        onLanOverviewClick = { viewModel.appState.openLanOverview() },
                        onPullRefresh = { onComplete -> viewModel.refreshManual(onComplete) },
                        onLoadPickerImages = viewModel::loadCanvasPickerImages,
                        // 画布沉浸开关（M5 4）：进=会话隐藏、退=还原。画布不经查看器的
                        // onClose，退出必须走还原分支，否则导航栏卡在隐藏
                        onSetImmersive = { setViewerSystemBars(it) },
                        // M5 3.1：网格选中集加入画布（FFI 解析宽高 → 装箱落 store）
                        onAddSelectionToCanvas = { ids, onDone ->
                            viewModel.canvasSourcesFor(ids) { sources ->
                                when (val r = viewModel.canvasStore.addImages(sources)) {
                                    is AddResult.Added -> {
                                        Toast.makeText(
                                            this@MainActivity,
                                            "已加入画布 ${r.added} 张（${viewModel.canvasStore.count}/24）",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                        onDone(r.added > 0)
                                    }
                                    AddResult.AllDuplicates -> {
                                        Toast.makeText(
                                            this@MainActivity, "所选图片都已在画布中", Toast.LENGTH_SHORT,
                                        ).show()
                                        onDone(false)
                                    }
                                    AddResult.Full -> {
                                        Toast.makeText(
                                            this@MainActivity, "画布已满（24/24）", Toast.LENGTH_SHORT,
                                        ).show()
                                        onDone(false)
                                    }
                                }
                            }
                        },
                        // —— M6a 阶段 4：LAN 浏览视图（总览数据/标题/上传入口/下拉刷新）——
                        lanOverviewFolders = viewModel.lanOverviewFolders.value,
                        lanServerName = lanSnapshot.serverName,
                        lanAllowUpload = viewModel.lanAllowUpload.value,
                        onLanUploadClick = { remotePath -> launchLanUpload(remotePath) },
                        onLanFolderRefresh = { onComplete -> viewModel.refreshLanFolder(onComplete) },
                        onLanRootsRefresh = { onComplete -> viewModel.refreshLanRoots(onComplete) },
                        // —— M6a 阶段 5：在线元数据/人物/专题（写回调统一落 LanClient，D31）——
                        lanRemoteTagGroups = viewModel.lanRemoteTagGroups.value,
                        lanPeople = viewModel.lanPeople.value,
                        lanTopics = viewModel.lanTopics.value,
                        lanAllowEdit = viewModel.lanAllowEdit.value,
                        onCreateLanTopic = { name ->
                            viewModel.createLanTopic(name) { topic ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (topic != null) "网络专题已创建" else "创建失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        onDeleteLanTopic = { topic ->
                            viewModel.deleteLanTopic(topic.id) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "专题已删除" else "删除失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        onAddSelectionToLanTopic = { topicId, paths ->
                            viewModel.addSelectionToLanTopic(topicId, paths) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已加入专题" else "加入专题失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                if (ok) viewModel.appState.exitSelectionMode()
                            }
                        },
                        onRenameLanPerson = { person, name ->
                            viewModel.renameLanPerson(person.id, name = name, description = null) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已重命名" else "重命名失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        onDescribeLanPerson = { person, description ->
                            viewModel.renameLanPerson(person.id, name = null, description = description) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已保存描述" else "保存失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        // —— M6a 阶段 6：互联态文件操作（删除/重命名/移动/复制/换头像）——
                        /** LAN 选中集批量删除（paths = 远端 path）；Toast 汇总 + 成功退选择。 */
                        onDeleteLanSelection = { paths ->
                            viewModel.deleteLanFiles(paths) { ok, fail ->
                                Toast.makeText(
                                    this@MainActivity,
                                    when {
                                        fail == 0 -> "已删除 $ok 张"
                                        ok == 0 -> "删除失败"
                                        else -> "已删除 $ok 张，失败 $fail 张"
                                    },
                                    Toast.LENGTH_SHORT,
                                ).show()
                                // 对齐 onRemoveFromTopic 先例：有成功才退选择（失败项留在
                                // 网格里可重试，退了选择反而丢上下文）
                                if (ok > 0) viewModel.appState.exitSelectionMode()
                            }
                        },
                        /** LAN 网格重命名（App 的 RenameDialog 提交；newName 是裸文件名）。 */
                        onRenameLanFile = { oldPath, newName ->
                            viewModel.renameLanFile(oldPath, newName) { ok, _ ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "已重命名" else "重命名失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                // 项身份随 rename 迁移（服务端换 path），选中集里的旧 path
                                // 已成悬空 id，退出选择模式比留着幽灵计数干净
                                if (ok) viewModel.appState.exitSelectionMode()
                            }
                        },
                        /** 目录选择弹窗的一次性远端 browse（VM 保证不动门禁位与主视图状态）。 */
                        onBrowseLanPath = { path, onReady ->
                            viewModel.browseLanPath(path, onReady)
                        },
                        /** 远端缩略图 URL 构造器（换头像弹窗图片行用；null 会话回 null）。 */
                        lanThumbnailUrlOf = viewModel.lanThumbnailUrlOf(),
                        /** LAN 选中集移动/复制到远端目录（type: "move" | "copy"）。 */
                        onCopyMoveLanFiles = { paths, targetDir, type ->
                            val verb = if (type == "copy") "复制" else "移动"
                            val onDone: (Int, Int, String?) -> Unit = { ok, fail, firstError ->
                                Toast.makeText(
                                    this@MainActivity,
                                    when {
                                        fail == 0 -> "已$verb $ok 张"
                                        ok == 0 -> "${verb}失败${firstError?.let { "：$it" } ?: ""}"
                                        else -> "已$verb $ok 张，失败 $fail 张"
                                    },
                                    if (ok == 0) Toast.LENGTH_LONG else Toast.LENGTH_SHORT,
                                ).show()
                                // move 有成功才退选择（源已不在）；copy 的副本不影响原
                                // 选中集，退选择对齐本地 performCopyMove 的完成回调
                                if (ok > 0) viewModel.appState.exitSelectionMode()
                            }
                            if (type == "copy") viewModel.copyLanFiles(paths, targetDir, onDone)
                            else viewModel.moveLanFiles(paths, targetDir, onDone)
                        },
                        /** 人物换头像落库（avatarPath = 弹窗选中的远端图 path）。 */
                        onChangeLanAvatar = { personId, imagePath ->
                            viewModel.renameLanPerson(personId, avatarPath = imagePath) { ok ->
                                Toast.makeText(
                                    this@MainActivity,
                                    if (ok) "头像已更新" else "换头像失败",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            }
                        },
                        // M6b 阶段 2：AI 任务挂钩与状态（打包进一个参数，见 AiUiHooks）
                        ai = AiUiHooks(
                            searchEnabled = viewModel.settings.value.aiSearchEnabled,
                            searchBusy = viewModel.aiSearchBusy.value,
                            renameProposals = viewModel.aiRenameProposals.value,
                            onSearchToggle = {
                                viewModel.setAiSearchEnabled(!viewModel.settings.value.aiSearchEnabled)
                            },
                            onSearchSubmit = { query -> viewModel.performAiSearch(query) },
                            onClearSearch = { viewModel.clearAiSearch() },
                            onAnalyze = { ids -> viewModel.startAiAnalysis(ids) },
                            onRename = { ids -> viewModel.startAiRename(ids) },
                            onFolderAnalyze = { ids -> viewModel.startAiFolderAnalysis(ids) },
                            onDismissRenameProposals = { viewModel.aiRenameProposals.value = null },
                            onApplyRenameProposals = { targets, onDone ->
                                viewModel.applyAiRenameProposals(targets, onDone)
                            },
                            // M6b 阶段 4/5：互联态人物与搜索（D37/D40）
                            onWd14PersonPipeline = { ids -> viewModel.startWd14PersonPipeline(ids) },
                            onOpenLanPersonFilter = { personId, name -> viewModel.openLanPersonFilter(personId, name) },
                            onOpenLanTopicFilter = { topicId -> viewModel.openLanTopicFilter(topicId) },
                        ),
                        // M6b 阶段 3：颜色搜索（TopBar 取色入口与查看器色块共用一态）
                        colorSearchHex = viewModel.colorSearchHex.value,
                        onColorSearch = { hex -> viewModel.startColorSearch(hex) },
                        onClearColorSearch = { viewModel.clearColorSearch() },
                        // M6b 阶段 4（D37）：本地人物快照（PeopleOverview/侧栏渲染）
                        // M6b 阶段 5（D36）：LAN 态搜索提交（App 内按 inLanBrowser 分流给 TopBar）
                        onLanSearchSubmit = { query -> viewModel.performLanSearch(query) },
                        localPeople = viewModel.localPeople.value,
                        language = viewModel.settings.value.language,
                        // 本地人物（手动那一半）：封面 uri / 创建时间摊平 + 写操作直转 VM
                        personCoverUris = viewModel.personCoverImagesById.value
                            .mapValues { it.value.contentUri },
                        personCoverCreatedAt = viewModel.personCoverImagesById.value
                            .mapValues { it.value.createdAt },
                        onOpenLocalPersonFilter = { personId -> viewModel.openLocalPersonFilter(personId) },
                        onCreateLocalPerson = { name, onDone -> viewModel.createLocalPerson(name, onDone) },
                        onRenameLocalPerson = { person, name, onDone ->
                            viewModel.renameLocalPerson(person.id, name, onDone)
                        },
                        onDescribeLocalPerson = { person, description, onDone ->
                            viewModel.describeLocalPerson(person.id, description, onDone)
                        },
                        onDeleteLocalPerson = { person, onDone ->
                            viewModel.deleteLocalPerson(person.id, onDone)
                        },
                        onAddFilesToLocalPersons = { personIds, fileIds, onDone ->
                            viewModel.addFilesToLocalPersons(personIds, fileIds, onDone)
                        },
                        onClearPersonsFromFiles = { personIds, fileIds, onDone ->
                            viewModel.clearPersonsFromFiles(personIds, fileIds, onDone)
                        },
                        onLoadAvatarCandidates = { personId, onReady ->
                            viewModel.loadLocalPersonMemberImages(personId) { images ->
                                onReady(images.map { AvatarCandidate(it.id, it.contentUri, it.name) })
                            }
                        },
                        onSaveLocalPersonAvatar = { personId, coverFileId, faceBox, onDone ->
                            viewModel.setLocalPersonAvatar(personId, coverFileId, faceBox, onDone)
                        },
                    )
                // 查看器叠在主内容之上，且不随网格的「扫描中」分支被拆掉（见 ViewerLayerHost）
                // M6b 阶段 3：查看器打开第一张的自动提取触发（翻页由 onNavigate 负责；
                // viewingFileId 变化即当前图变化，in-flight 防重让与 onNavigate 的重复触发幂等）
                LaunchedEffect(appState.activeTab.viewingFileId) {
                    appState.activeTab.viewingFileId?.let { maybeAutoExtractPalette(it) }
                }
                // 查看器不在这里挂：它要真全屏（不吃 statusBarsPadding），挂在上面那层
                // 全屏 Box 的末尾（主内容之后 → 盖在网格之上）。见下方 ViewerLayerHost。
                // M6b 阶段 5（D40）：桌面词表推进查看器（LAN 项标签编辑建议源）
                LaunchedEffect(viewModel.lanVocab.value) {
                    ensureViewer().lanVocab = viewModel.lanVocab.value
                }
                // M4c：设置宿主（平板 ≥600dp 桌面式双栏对话框 / 手机全屏设置页，D21 双形态）
                if (showSettings) {
                    SettingsHost(
                        settings = viewModel.settings.value,
                        cacheSizeText = computeCacheSizeText(),
                        appVersion = appVersion,
                        // D50：更新检查状态机（关于页「软件更新」区与更新弹窗共用）
                        update = viewModel.updateController,
                        // M6a 阶段 3：LAN 状态机（面板消费同一快照 + 连接/断开操作）
                        lan = viewModel.lan,
                        // M6a 阶段 7：对等服务端单例（面板「允许桌面浏览本机」开关；未 init 为 null）
                        lanServer = viewModel.lanServerManager,
                        onLanguageChange = { viewModel.setLanguage(it) },
                        // M6b 阶段 2：AI 设置逐项即时保存（面板草稿直接落 prefs）
                        onAiSettingsChange = { viewModel.updateAiSettings(it) },
                        onThemeChange = { viewModel.setTheme(it) },
                        onDefaultLayoutChange = { viewModel.applyDefaultLayout(it) },
                        onDefaultSortChange = { by, dir -> viewModel.applyDefaultSort(by, dir) },
                        onDefaultGroupByChange = { viewModel.applyDefaultGroupBy(it) },
                        onClearCache = { clearCache() },
                        onExportBackup = { exportBackup() },
                        onImportBackup = { importBackupLauncher.launch(arrayOf("application/json")) },
                        onOpenUrl = { openExternalUrl(it) },
                        onDismiss = { showSettings = false },
                        // —— M6b 阶段 3：主色调数据库面板（VM 状态 → 面板类型映射 + 操作直连）——
                        colorStats = viewModel.colorStats.value?.let {
                            PanelColorStats(
                                total = it.total,
                                pending = it.pending,
                                extracted = it.extracted,
                                error = it.error,
                                libraryImages = it.libraryImages,
                                dbSizeBytes = it.dbSizeBytes,
                            )
                        },
                        colorTask = viewModel.colorTaskState.value?.let {
                            PanelColorTask(it.current, it.total, it.paused)
                        },
                        colorErrorCount = viewModel.colorErrorCount.value,
                        autoExtractPalette = viewModel.settings.value.autoExtractPalette,
                        onStartColorExtract = { viewModel.startColorBatchExtract() },
                        onPauseColorExtract = { viewModel.pauseColorBatch() },
                        onResumeColorExtract = { viewModel.resumeColorBatch() },
                        onCancelColorExtract = { viewModel.cancelColorBatch() },
                        onRetryColorErrors = { viewModel.retryColorErrors() },
                        onDeleteColorErrors = { viewModel.deleteColorErrors() },
                        onCleanupColorRecords = { viewModel.cleanupColorRecords() },
                        onAutoExtractChange = { viewModel.setAutoExtractPalette(it) },
                        onRefreshColorPanel = { viewModel.refreshColorPanel() },
                        // 侧栏「网络」跳转的落点（null = 常规，见 settingsInitialCategory 注释）
                        initialCategory = settingsInitialCategory,
                    )
                }
                // D50：更新弹窗——命中新版本且未被「稍后提醒」收起时渲染（关于页入口不受影响）。
                // 与设置里的关于页共用同一实例，下载中切到关于页能看到同一条进度。
                if (viewModel.updateController.showBanner) {
                    UpdateDialog(
                        update = viewModel.updateController,
                        onDismiss = { viewModel.updateController.dismiss() },
                    )
                }
                // —— 首启欢迎向导（启动流程优化）：全屏覆盖层，完成后写 onboarded 并揭幕 ——
                if (showWelcome) {
                    val welcomeLanSnap by viewModel.lanServer.snapshot.collectAsState()
                    WelcomeFlow(
                        state = welcomeState,
                        onStateChange = { welcomeState = it },
                        permissionDenied = welcomePermissionDenied,
                        theme = viewModel.settings.value.theme,
                        language = viewModel.settings.value.language,
                        ai = viewModel.settings.value.ai,
                        lanSnapshot = welcomeLanSnap,
                        darkTheme = dark,
                        onThemeChange = { viewModel.setTheme(it) },
                        onLanguageChange = { viewModel.setLanguage(it) },
                        onAiChange = { viewModel.updateAiSettings(it) },
                        aiTestConnection = { ai ->
                            val cfg = ai.toAiConfig(viewModel.settings.value.language)
                            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                                runCatching { uniffi.aurora_core.aiCheckConnection(cfg); Unit }
                            }
                        },
                        enableLanServer = { viewModel.lanServer.setEnabledOn(autoEnable = true) },
                        onRequestPermission = {
                            welcomePermissionDenied = false
                            requestPermission.launch(mediaPermission())
                        },
                        onOpenAppSettings = { openAppDetailsSettings() },
                        onFinish = {
                            viewModel.settingsStore.saveOnboarded()
                            showWelcome = false
                        },
                    )
                }
                // ↑ 主内容层收口（吃 statusBarsPadding）
                }
                // 查看器：真全屏覆盖层，画在主内容之上、设置页/欢迎向导之前（后者与查看器
                // 不同屏共存，不受影响）。容器不吃 insets 是 B2 的核心——沉浸隐藏系统栏
                // 时容器尺寸恒定，图片不重居中，进出零位移。
                ViewerLayerHost(
                    state = appState,
                    displayImages = displayImages,
                    viewerProvider = ::ensureViewer,
                    parentName = currentFolderName,
                    tagsByFile = viewModel.tagsByFile.value,
                    metadataById = viewModel.metadataById.value,
                    // M6a 阶段 5：远端元数据缓存——isLan 项抽屉的标签/描述/来源只取这里
                    lanMetaById = viewModel.lanMetaByPath.value,
                    // M6a 阶段 4：LAN 大图 URL 构造器（查看器 isLan 项的取图源）
                    lanImageUrlOf = viewModel.lanImageUrlOf(),
                    // M6a 阶段 6：编辑门禁位（查看器 LAN 项的删除入口显隐；同款会话现取）
                    lanAllowEdit = viewModel.lanAllowEdit.value,
                    // M6b 阶段 3：抽屉 Section 4 主色调预填 + 自动提取开关推进
                    colorPalettesById = viewModel.colorPalettesById.value,
                    autoExtractPalette = viewModel.settings.value.autoExtractPalette,
                )
                }
            }
        }

        // —— 首启欢迎向导（启动流程优化 2026-09-29，设计文档 4.3）——
        // 首启（无 onboarded 标记且媒体权限未授予）→ 先走欢迎向导，权限申请挪进向导权限步
        // （带拒绝兜底），替代原先冷启动裸弹系统权限框；其余路径（老用户升级已授权 /
        // 已 onboarded）行为与 2.0.0 完全一致，缺标记时静默补写不弹向导。
        val onboarded = viewModel.settingsStore.loadOnboarded()
        if (!onboarded && !hasMediaPermission()) {
            welcomeState = WelcomeFlowState.initial(false)
            welcomePermissionDenied = false
            showWelcome = true
        } else {
            if (!onboarded) viewModel.settingsStore.saveOnboarded()
            requestMediaPermissionIfNeeded()
        }

        // M6b 阶段 2：AI 任务通知「取消」action 的常驻接收（非调试钩子——通知是生产
        // 面向用户的，收不到取消按钮就成了摆设）。NOT_EXPORTED + 显式包名， PendingIntent
        // 由 ScanNotifier 以同构 Intent 发出。
        ContextCompat.registerReceiver(
            this,
            aiCancelReceiver,
            IntentFilter(ScanNotifier.ACTION_AI_CANCEL),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        // M6b 阶段 3：主色调批量提取通知按钮（暂停/恢复/停止）的常驻接收，同 AI 取消先例。
        ContextCompat.registerReceiver(
            this,
            colorTaskReceiver,
            IntentFilter(ScanNotifier.ACTION_COLOR_TASK),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        // M7 收口销账：FFI_SMOKE/FILEOP/PINCH 调试广播钩子随里程碑移除
        // （曾登记「归 M7 清理」，M6a-8/M6b-8 LanSmoke/AiSmoke 同款先例）。

        // M8b-15：pre-IME 返回拦截壳（用户要求「点击搜索时可用返回键关闭搜索框」）。
        // setContent 后立即重挂——此刻 ComposeView 尚未 attach 到窗口，零生命周期扰动。
        installPreImeInterceptor()
    }

    /** M8b-15：pre-IME 返回拦截壳（见 [PreImeInterceptorLayout]；null=未装成，功能静默缺席）。 */
    internal var preImeInterceptor: PreImeInterceptorLayout? = null
        private set

    private fun installPreImeInterceptor() {
        val content = findViewById<ViewGroup>(android.R.id.content)
        if (content.childCount != 1) return
        val compose = content.getChildAt(0)
        content.removeAllViews()
        val interceptor = PreImeInterceptorLayout(this)
        content.addView(
            interceptor,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        interceptor.addView(compose, compose.layoutParams)
        preImeInterceptor = interceptor
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
     * 4.2 删除：**先直删**（用户要求编辑直接生效、不弹系统窗）。本应用自建/已授权过的
     * 行系统直接放行；非本应用创建的行会被系统拦下（RecoverableSecurityException），
     * 只对那几行发一次 createDeleteRequest 授权，允许后重试（API ≥ 30 才有该 API，
     * < 30 只能提示放弃）。完成后的索引对账都由 MediaStore observer 自动完成。
     */
    private fun requestDelete(uris: List<Uri>) {
        if (uris.isEmpty()) return
        viewModel.deleteDirect(
            uris,
            onDone = { n ->
                if (n > 0) {
                    viewModel.appState.exitSelectionMode()
                } else {
                    Toast.makeText(this, "删除失败", Toast.LENGTH_SHORT).show()
                }
            },
            onBlocked = { blocked, retry ->
                if (Build.VERSION.SDK_INT >= 30) {
                    withMediaWriteConsent(opJson("delete", blocked)) {
                        try {
                            pendingDeleteRetry = retry
                            val pi = MediaStore.createDeleteRequest(contentResolver, blocked)
                            deleteLauncher.launch(IntentSenderRequest.Builder(pi.intentSender).build())
                        } catch (e: Exception) {
                            pendingDeleteRetry = null
                            Log.w("AuroraKotlin", "[Delete] createDeleteRequest failed", e)
                            Toast.makeText(this, "删除请求失败", Toast.LENGTH_SHORT).show()
                        }
                    }
                } else {
                    Toast.makeText(
                        this,
                        "有 ${blocked.size} 张不是本应用创建的，无法删除",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            },
        )
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

    /**
     * 「管理媒体」设置的回程：消费 SP 里待执行的操作——已授予则重发整批操作，直写直接
     * 成功（零弹窗兑现，对已成功的部分重跑是幂等的）；没授予则提示重做。
     */
    override fun onResume() {
        super.onResume()
        // 沉浸态重申：切后台/被系统面板打断时系统可能自行把栏放回来，回前台按查看器
        // 的权威沉浸态重申一次（幂等——setViewerImmersiveBars 同值短路，非沉浸不做事）
        viewer?.takeIf { it.isImmersiveNow() }?.let { setViewerImmersiveBars(true) }
        // 欢迎向导权限步：用户从系统设置授权页返回时 launcher 不会回调——这里按当前
        // 权限态推进（授权了就走 onPermissionGranted 并开扫，仍被拒则留在权限步）
        if (showWelcome && welcomeState.step == WelcomeStep.PERMISSION && hasMediaPermission()) {
            welcomeState = welcomeState.onPermissionGranted()
            viewModel.startScanIfNeeded()
        }
        val op = consumePendingOp() ?: return
        if (hasAllFilesAccess()) {
            Log.i("AuroraKotlin", "[FileOp] all-files granted, resuming pending op: ${op.optString("type")}")
            dispatchPendingOp(op)
        } else {
            Log.i("AuroraKotlin", "[FileOp] all-files not granted, pending op dropped")
            Toast.makeText(this, "未开启「管理媒体」，请重新执行刚才的操作", Toast.LENGTH_LONG).show()
        }
    }

    override fun onStop() {
        super.onStop()
        viewModel.stopMediaStoreObservation()
    }

    /** M6b 阶段 2：通知「取消」action → core 取消注册表（生产接收器，常驻注册）。 */
    private val aiCancelReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            viewModel.cancelAiTask()
        }
    }

    /** M6b 阶段 3：主色调批量提取通知按钮回传（cmd ∈ pause|resume|stop，ScanNotifier.taskAction 发出）。 */
    private val colorTaskReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getStringExtra(ScanNotifier.EXTRA_CMD)) {
                "pause" -> viewModel.pauseColorBatch()
                "resume" -> viewModel.resumeColorBatch()
                "stop" -> viewModel.cancelColorBatch()
            }
        }
    }

    /** 阶段 5：通知权限（API 33+ 运行时请求；拒绝则扫描通知静默不发，不影响功能）。 */
    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 拒绝也不阻断：通知只是增强 */ }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /** 媒体库读权限字符串：设备 API 33+ **且** targetSdk ≥ 33 才用 READ_MEDIA_IMAGES
     *  （该权限只对 targetSdk ≥ 33 的应用生效；targetSdk < 33 时走 READ_EXTERNAL_STORAGE
     *  的媒体映射，声明掐了会拿残缺索引）。须与 GalleryViewModel.hasMediaPermission 一致。 */
    private fun mediaPermission(): String =
        if (Build.VERSION.SDK_INT >= 33 &&
            applicationInfo.targetSdkVersion >= 33
        ) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }

    private fun hasMediaPermission(): Boolean =
        checkSelfPermission(mediaPermission()) == PackageManager.PERMISSION_GRANTED

    private fun requestMediaPermissionIfNeeded() {
        if (hasMediaPermission()) {
            viewModel.startScanIfNeeded()
            requestWritePermissionIfNeeded()
            requestNotificationPermissionIfNeeded()
        } else {
            // READ 授权回调里会再进 WRITE 补请求，见 requestPermission 的 granted 分支
            requestPermission.launch(mediaPermission())
        }
    }

    /** 欢迎向导权限拒绝兜底：跳系统应用详情页；授权后 onResume 推进（launcher 不回调）。 */
    private fun openAppDetailsSettings() {
        try {
            startActivity(
                android.content.Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.fromParts("package", packageName, null),
                ),
            )
        } catch (e: Exception) {
            Log.w("AuroraKotlin", "[Welcome] open app settings failed", e)
            Toast.makeText(this, "无法打开系统设置", Toast.LENGTH_SHORT).show()
        }
    }
}

/**
 * M6b 阶段 2：AI 任务的 UI 挂钩与状态快照。[App] 是无 VM 依赖的顶层组合根（本仓惯例：
 * 数据与操作全走参数），AI 的状态/操作以此打包进一个参数。
 */
data class AiUiHooks(
    /** TopBar AI 搜索开关（设置持久化快照）。 */
    val searchEnabled: Boolean,
    /** AI 搜索请求进行中。 */
    val searchBusy: Boolean,
    /** AI 改名提案（非 null=弹确认框）。 */
    val renameProposals: List<Triple<Image, String, String>>?,
    val onSearchToggle: () -> Unit,
    val onSearchSubmit: (String) -> Unit,
    val onClearSearch: () -> Unit,
    /** 批量 AI 分析（网格多选/查看器单张）。 */
    val onAnalyze: (List<String>) -> Unit,
    /** 批量 AI 重命名（提案经 renameProposals 回流确认）。 */
    val onRename: (List<String>) -> Unit,
    /** 相册卡片批量 AI 分析（成员=所选相册全部图片）。 */
    val onFolderAnalyze: (List<String>) -> Unit,
    val onDismissRenameProposals: () -> Unit,
    /** 应用改名提案（直写走 M4b renameFiles，被系统拦下才由宿主补一次授权）。 */
    val onApplyRenameProposals: (targets: List<Pair<Uri, String>>, onDone: (Int) -> Unit) -> Unit,
    // —— M6b 阶段 4/5：互联态人物与搜索（App 无 VM 引用，经 hooks 惯例传入）——
    /** WD14 人物识别（D37：图字节卸载桌面 → 标签/人物写本地库；VM 内拦未连接）。 */
    val onWd14PersonPipeline: (List<String>) -> Unit,
    /** 远端人物点击 → 成员筛选虚拟目录（D40：GET /api/people/members）。 */
    val onOpenLanPersonFilter: (personId: String, name: String) -> Unit,
    /** 远端专题点击 → 成员筛选虚拟目录（D40：GET /api/topic/members）。 */
    val onOpenLanTopicFilter: (topicId: String) -> Unit,
)

@Composable
fun App(
    state: AppState,
    /** 当前是否深色档（画布 View 的取色入参；M4c 主题链在 setContent 推导）。 */
    darkTheme: Boolean = false,
    /** 画布状态（M5 1.2；实例在 GalleryViewModel，进程内保活）。 */
    canvasStore: com.aurora.gallery.kotlin.canvas.CanvasStore,
    folders: List<Folder>,
    /** 本地总览封面重选（2026-10 排序改造）：folderId → 按当前排序口径选中的封面；缺项回退原 cover。 */
    localCoverOverrides: Map<String, String>,
    /** 2026-10-08 文件夹活动时间：folderId → epoch 秒（写操作 bump）。总览 date 排序键 =
     *  max(内容最新时间, 活动时间)——「操作过文件夹就排前面」，删除也不例外。 */
    folderActivityAt: Map<String, Long>,
    images: List<Image>,
    /** 展示序列（过滤+排序后）由组合根算好传入：查看器的进入序列必须是同一条（M3 2.2）。 */
    displayImages: List<Image>,
    /** M8b-23：序列取数进行中（换视图清空后、结果未落地）。空态文案的门闩——「还没查完」
     *  不是「真的空」，否则进文件夹的头一两帧会先闪「文件夹为空」（用户报障）。 */
    imagesPending: Boolean,
    /** 侧栏标签 Section 的分组 + 计数（Rust 算好的顺序原样渲染，M4a 3.1）。 */
    tagGroups: List<TagGroup>,
    /** 全部专题（M4a 3.2 总览网格）。 */
    topics: List<uniffi.aurora_core.FfiTopic>,
    /** coverFileId → Image（专题卡片封面）。 */
    coverImagesById: Map<String, Image>,
    /** 界面语言（人物拼音分组要用，与标签分组同一个 locale）。 */
    language: String = "zh",
    /** 本地人物 coverFileId → 封面创建时间（秒），人物总览「按创建时间」排序用。 */
    personCoverCreatedAt: Map<String, Long> = emptyMap(),
    scanning: Boolean,
    thumbnailLoader: ThumbnailLoader,
    /**
     * 点开一张图 = 带过渡地打开查看器（2026-10-08）。第二参是那张卡片的封面视图，
     * 进入动画拿它的矩形与已解码缩略图当动画源。选择模式让位给勾选，判断在下方
     * [onImageClick] 里，宿主只管开。
     */
    onOpenViewer: (Image, ImageView) -> Unit,
    /**
     * 查看器退出动画的落点通道（2026-10-08）：本网格把「按 id 取可见卡片封面矩形」注册进来，
     * Activity 侧在关闭那一刻读它。身份由 Activity 持有，跨重组稳定（见 PhotoRectQuery）。
     */
    viewerPhotoRectQuery: PhotoRectQuery,
    /** M6a 阶段 3：LAN 连接快照（网络 Section 消费；宿主 setContent 里 collect）。 */
    lanSnapshot: LanSnapshot,
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
    /** 4.3 编辑标签弹窗的数据源：file_id → 标签（VM 快照原样）。 */
    tagsByFile: Map<String, List<String>>,
    /** 4.3 复制标签：选中集标签并集存应用内剪贴板（宿主做，反馈也在这里）。 */
    onCopyTags: (Set<String>) -> Unit,
    /** 4.3 粘贴标签：剪贴板标签合并进选中集（1.1 批量原语，宿主落库）。 */
    onPasteTags: (Set<String>) -> Unit,
    /** 4.3 编辑标签保存：单文件标签整体替换（2.1 的 saveFileUpdates，唯一写入口）。 */
    onSaveFileTags: (String, List<String>) -> Unit,
    /** 4.3 专题重命名落库（upsertTopic 整行写）。 */
    onRenameTopic: (uniffi.aurora_core.FfiTopic, String) -> Unit = { _, _ -> },
    /** 4.3 专题删除落库（递归删子专题）。 */
    onDeleteTopic: (uniffi.aurora_core.FfiTopic) -> Unit = {},
    /** 4.3 设为专题封面（详情选择模式的触屏同位入口）。 */
    onSetTopicCover: (topicId: String, fileId: String) -> Unit = { _, _ -> },
    // —— M4b 1.4 文件操作（网格入口；执行在宿主，弹窗状态在本组合）——
    /** 复制/移动到既有相册（宿主解析 RELATIVE_PATH + 授权 + 调写原语）。 */
    onCopyMoveFiles: (fileIds: List<String>, targetFolderId: String, type: String) -> Unit = { _, _, _ -> },
    /** 复制/移动到**新相册**（1.3 懒创建；宿主校验名字后建在 Pictures/<名字>）。 */
    onCopyMoveToNewAlbum: (fileIds: List<String>, albumName: String, type: String) -> Unit = { _, _, _ -> },
    /** 总览选中的文件夹卡片展开成成员图片 id（复制/移动/删除的统一前置）。 */
    onResolveSelectionFileIds: (Set<String>, (List<String>) -> Unit) -> Unit = { _, _ -> },
    /** 网格重命名（1.4 单选菜单项；宿主过写授权后改 DISPLAY_NAME）。 */
    onRenameFile: (fileId: String, newName: String) -> Unit = { _, _ -> },
    /** 打开设置面板（M4b 2.1；对话框由宿主层渲染）。 */
    onOpenSettings: () -> Unit = {},
    /**
     * 侧栏「网络」行未连接时的点击（2026-09-26 验收反馈）：打开设置并直接落在局域网
     * 共享页（宿主置 settingsInitialCategory = LAN 再开面板）。
     */
    onLanSettingsClick: () -> Unit = {},
    /**
     * 侧栏「网络」行已连接时的点击（2026-09-26 二轮反馈）：进 LAN 文件夹总览，
     * 同「本地相册」头部点击回总览的语义。
     */
    onLanOverviewClick: () -> Unit = {},
    /** 4.4 下拉刷新：宿主触发扫描，完成时回调 [onComplete]（指示器落勾）。 */
    onPullRefresh: ((onComplete: () -> Unit) -> Unit),
    /** M5 3.1：选中集加入画布（宿主解析 FFI 源 + 落 store + 反馈）；[onDone] 报告是否真有加入。 */
    onAddSelectionToCanvas: (Collection<String>, onDone: (Boolean) -> Unit) -> Unit = { _, _ -> },
    /** M5 3.3：添加图片弹窗的四类数据源取数（宿主转 GalleryViewModel）。 */
    onLoadPickerImages: (String, String, (List<Image>) -> Unit) -> Unit = { _, _, _ -> },
    /** M5 4：画布沉浸开关（宿主转 setViewerSystemBars）。 */
    onSetImmersive: (Boolean) -> Unit = {},
    // —— M6a 阶段 4：LAN 浏览视图 ——
    /** LAN 总览的文件夹卡片序列（GalleryViewModel.lanOverviewFolders，数据层算好的结构）。 */
    lanOverviewFolders: List<uniffi.aurora_core.Folder> = emptyList(),
    /** 服务端上报名（TopBar 标题用；null/空退回「局域网」）。 */
    lanServerName: String? = null,
    /** 上传门禁位（allow_upload；false 时入口置灰，点击宿主 Toast 提示）。 */
    lanAllowUpload: Boolean = false,
    /** 上传入口点击（宿主起系统照片选择器；参数=目标远端 path，共享根传空串）。 */
    onLanUploadClick: (String) -> Unit = {},
    /** LAN 目录网格的下拉刷新（重拉当前远端目录）。 */
    onLanFolderRefresh: ((onComplete: () -> Unit) -> Unit) = {},
    /** LAN 总览的下拉刷新（重拉 all_image_folders）。 */
    onLanRootsRefresh: ((onComplete: () -> Unit) -> Unit) = {},
    // —— M6a 阶段 5：在线元数据/人物/专题（D31 并入口径；数据层会话缓存 + LanClient 写）——
    /** 远端词表分组（侧栏标签 Section 的归并数据源；Rust 定序，UI 不重排）。 */
    lanRemoteTagGroups: List<TagGroup> = emptyList(),
    /** 远端人物（侧栏人物 Section + 人物总览卡网格）。 */
    lanPeople: List<com.aurora.gallery.kotlin.LanPerson> = emptyList(),
    /** 远端专题（专题总览远端块 + LAN 网格「加入专题…」选择弹窗）。 */
    lanTopics: List<com.aurora.gallery.kotlin.LanTopic> = emptyList(),
    /** 编辑门禁位（allow_edit；D32 默认 true 直通，false 时 LAN 网格的写入口不出现）。 */
    lanAllowEdit: Boolean = false,
    /** 新建网络专题（宿主调 createLanTopic，反馈也在宿主）。 */
    onCreateLanTopic: (String) -> Unit = {},
    /** 删除网络专题（宿主弹确认后调 deleteLanTopic，反馈也在宿主）。 */
    onDeleteLanTopic: (com.aurora.gallery.kotlin.LanTopic) -> Unit = {},
    /** LAN 网格选中集归入远端专题（paths = 选中项的远端 path；宿主落写 + Toast）。 */
    onAddSelectionToLanTopic: (topicId: String, paths: List<String>) -> Unit = { _, _ -> },
    /** 远端人物重命名（宿主调 renameLanPerson(id, name, null)）。 */
    onRenameLanPerson: (com.aurora.gallery.kotlin.LanPerson, String) -> Unit = { _, _ -> },
    /** 远端人物改描述（宿主调 renameLanPerson(id, null, description)）。 */
    onDescribeLanPerson: (com.aurora.gallery.kotlin.LanPerson, String) -> Unit = { _, _ -> },
    // —— M6a 阶段 6：互联态文件操作（执行在宿主，弹窗状态在本组合，与本地文件操作同构）——
    /** LAN 选中集批量删除（paths = 选中项的远端 path；宿主落写 + Toast + 成功退选择）。 */
    onDeleteLanSelection: (paths: List<String>) -> Unit = {},
    /** LAN 网格重命名（oldPath = 远端 path；newName 为裸文件名，目录由服务端拼）。 */
    onRenameLanFile: (oldPath: String, newName: String) -> Unit = { _, _ -> },
    /** 目录选择弹窗的一次性远端 browse（宿主转 browseLanPath；失败回 null 弹窗自兜底）。 */
    onBrowseLanPath: (path: String?, onReady: (LanBrowseResult?) -> Unit) -> Unit = { _, onReady -> onReady(null) },
    /** 远端缩略图 URL 构造器（AVATAR 模式图片行；null 会话 = null，行退化占位底）。 */
    lanThumbnailUrlOf: ((String) -> String?)? = null,
    /** LAN 选中集移动/复制到远端目录（type: "move" | "copy"，对齐本地 onCopyMoveFiles）。 */
    onCopyMoveLanFiles: (paths: List<String>, targetDir: String, type: String) -> Unit = { _, _, _ -> },
    /** 人物换头像（personId + 弹窗选中的远端图 path；宿主转 renameLanPerson(avatarPath=)）。 */
    onChangeLanAvatar: (personId: String, imagePath: String) -> Unit = { _, _ -> },
    /** M6b 阶段 2：AI 任务的 UI 挂钩与状态（见 [AiUiHooks]）。 */
    ai: AiUiHooks,
    // —— M6b 阶段 3：颜色搜索（TopBar 取色入口；hex 非 null=颜色过滤态）——
    colorSearchHex: String? = null,
    /** 本地人物快照（手动维护 + 历史 WD14 产物；PeopleOverview/侧栏渲染）。 */
    localPeople: List<uniffi.aurora_core.FfiPerson> = emptyList(),
    // —— 本地人物：桌面 usePeople 手动那一半的移植（宿主执行在 VM，弹窗状态在本组合）——
    /** 本地人物封面：coverFileId → contentUri（真头像用；宿主从 VM personCoverImagesById 摊平）。 */
    personCoverUris: Map<String, String> = emptyMap(),
    /** 点本地人物卡 = 进该人物的筛选视图（宿主转 openLocalPersonFilter）。 */
    onOpenLocalPersonFilter: (personId: String) -> Unit = {},
    /** 页头「新建人物」提交（宿主转 createLocalPerson；回调 ok 供 Toast）。 */
    onCreateLocalPerson: (name: String, onDone: (Boolean) -> Unit) -> Unit = { _, cb -> cb(false) },
    /** 本地人物重命名 / 改描述 / 删除（宿主转 VM 同名方法）。 */
    onRenameLocalPerson: (uniffi.aurora_core.FfiPerson, String, (Boolean) -> Unit) -> Unit = { _, _, cb -> cb(false) },
    onDescribeLocalPerson: (uniffi.aurora_core.FfiPerson, String, (Boolean) -> Unit) -> Unit = { _, _, cb -> cb(false) },
    onDeleteLocalPerson: (uniffi.aurora_core.FfiPerson, (Boolean) -> Unit) -> Unit = { _, cb -> cb(false) },
    /**
     * 网格选中集「添加到人物…」（personIds = 弹窗勾选的人物；fileIds = 选中图）。
     * 回调 (成功张数, 失败张数) 供宿主拼 Toast。
     */
    onAddFilesToLocalPersons: (List<String>, List<String>, (Int, Int) -> Unit) -> Unit = { _, _, cb -> cb(0, 0) },
    /** 网格选中集「清除人物信息…」（桌面文件右键同位）：解绑所选人物与这些图的关系。 */
    onClearPersonsFromFiles: (List<String>, List<String>, (Int, Int) -> Unit) -> Unit = { _, _, cb -> cb(0, 0) },
    /** 取该人物的成员图作裁剪页的换封面候选（宿主转 VM localPersonMemberImages）。 */
    onLoadAvatarCandidates: (personId: String, onReady: (List<AvatarCandidate>) -> Unit) -> Unit =
        { _, cb -> cb(emptyList()) },
    /** 保存头像（封面图 id + faceBox 百分比；宿主转 VM setLocalPersonAvatar）。 */
    onSaveLocalPersonAvatar: (String, String, uniffi.aurora_core.FfiFaceBox?, (Boolean) -> Unit) -> Unit =
        { _, _, _, cb -> cb(false) },
    onColorSearch: (String) -> Unit = {},
    onClearColorSearch: () -> Unit = {},
    /** M6b 阶段 5（D36）：LAN 态搜索提交（文件名/CLIP 按 AI 开关在 VM 内分流）。 */
    onLanSearchSubmit: ((String) -> Unit)? = null,
) {
    // 活动标签驱动 UI：folderId × folders 得出当前文件夹；viewMode 决定总览或文件夹网格
    val tab = state.activeTab
    val currentFolder = tab.folderId?.let { id -> folders.firstOrNull { it.id == id } }
    val context = LocalContext.current
    val density = LocalDensity.current
    val configuration = LocalConfiguration.current
    // M4c D21：横屏手机 = 宽 ≥600dp 且高 <480dp——设置双形态断点外的第三形态，
    // 侧栏「设置」行被裁切，入口挂顶栏（onOpenSettings 传 TopBar）
    val isLandscapePhone = configuration.let {
        it.screenWidthDp >= 600 && it.screenHeightDp < 480
    }
    // M5 D28：平板形态（宽 ≥600dp 且高 ≥480dp，横屏手机不算；M8b 1.1 判据收敛）——
    // 画布是平板专属能力，侧栏「画布」行与网格/查看器的画布入口都按此门控
    val isTablet = com.aurora.gallery.kotlin.ui.isTabletForm(configuration)
    // M8b 1.2（D45）：抽屉形态 = !isTablet（竖屏手机 + 横屏手机），侧栏宿主在
    // PhoneSidebarDrawerHost（平移抽屉）与 SidebarPane（平板推挤，零改动）间分叉
    val isPhone = !isTablet
    // 抽屉面板宽（屏宽 82% 封顶 420dp，v3 拍板带内取档）；TreeSidebar 宽度档与抽屉宿主共用此式
    val drawerPanelWidthDp =
        com.aurora.gallery.kotlin.ui.components.phoneSidebarPanelWidthDp(configuration.screenWidthDp)
    // 网格列数语义隔离（1.2 红线：抽屉平移不重排）：手机下网格把「侧栏开合」当恒否——
    // FileGrid/FoldersOverview 的 sidebarVisible 只驱动「推挤宽度预测」，抽屉形态主内容
    // 宽度不变，传 true 会让列数随抽屉开合重算（FLIP）。平板传原值，推挤预测照旧。
    val gridSidebarVisible = state.layout.isSidebarVisible && !isPhone
    // 4.4 下拉刷新的触发阈值（80dp，React threshold 同值）
    val ptrThresholdPx = with(density) { 80.dp.toPx() }

    // 4.3 返回链需要读取/关闭搜索胶囊（React 里是 searchInput focused 的判断），提升到这里
    var searchOpen by remember { mutableStateOf(false) }
    // 4.2 删除确认弹窗
    var showDeleteConfirm by remember { mutableStateOf(false) }
    // M4a 3.2 新建专题弹窗（TopicsOverview 的「新建专题」按钮触发）
    var showCreateTopic by remember { mutableStateOf(false) }
    // M6a 阶段 5 新建**网络**专题弹窗（TopicsOverview 的远端新建入口触发）
    var showCreateLanTopic by remember { mutableStateOf(false) }
    // M4a 3.2 专题选择弹窗（选择模式「更多」→「加入专题…」触发）
    var showTopicPicker by remember { mutableStateOf(false) }
    // 「添加到人物…」的人物多选弹窗（本地人物；形制同 showTopicPicker）
    var showPersonPicker by remember { mutableStateOf(false) }
    // 「清除人物信息…」复用同一个多选弹窗，只是语义反过来（勾=要解绑的人物）
    var showPersonUnpicker by remember { mutableStateOf(false) }
    // M6a 阶段 5 远端专题选择弹窗（LAN 目录网格「加入专题…」触发）
    var showLanTopicPicker by remember { mutableStateOf(false) }
    // M4a 4.3 「更多」菜单开合（受控）：长按已选中项时从网格侧打开
    var moreExpanded by remember { mutableStateOf(false) }
    // M4a 4.3 编辑标签弹窗的目标文件（单选菜单项触发）
    var editTagsFileId by remember { mutableStateOf<String?>(null) }
    // M4a 4.3 专题卡片长按菜单 → 重命名 / 删除确认弹窗的目标
    var renameTopicState by remember { mutableStateOf<uniffi.aurora_core.FfiTopic?>(null) }
    var deleteTopicState by remember { mutableStateOf<uniffi.aurora_core.FfiTopic?>(null) }
    // M6a 阶段 5 远端条目的弹窗目标（确认/输入弹窗的宿主态）
    var deleteLanTopicState by remember { mutableStateOf<com.aurora.gallery.kotlin.LanTopic?>(null) }
    var renameLanPersonState by remember { mutableStateOf<com.aurora.gallery.kotlin.LanPerson?>(null) }
    var describeLanPersonState by remember { mutableStateOf<com.aurora.gallery.kotlin.LanPerson?>(null) }
    // 本地人物的弹窗目标（新建 / 重命名 / 改描述 / 删除确认），形制同上面两条远端人物态
    var createPersonOpen by remember { mutableStateOf(false) }
    var renameLocalPersonState by remember { mutableStateOf<uniffi.aurora_core.FfiPerson?>(null) }
    var describeLocalPersonState by remember { mutableStateOf<uniffi.aurora_core.FfiPerson?>(null) }
    var deleteLocalPersonState by remember { mutableStateOf<uniffi.aurora_core.FfiPerson?>(null) }
    // 头像裁剪页的目标人物 + 它的换封面候选（开页时按成员图现拉，见 onLoadAvatarCandidates）
    var cropAvatarPerson by remember { mutableStateOf<uniffi.aurora_core.FfiPerson?>(null) }
    var cropAvatarCandidates by remember { mutableStateOf<List<AvatarCandidate>>(emptyList()) }
    // M6a 阶段 6 互联态文件操作的弹窗目标：重命名的远端 path、目录选择器的模式
    // （移动/复制/换头像）与换头像的目标人物（AVATAR 模式提交流程要用）
    var lanRenamePath by remember { mutableStateOf<String?>(null) }
    var lanPickerMode by remember { mutableStateOf<LanPickerMode?>(null) }
    var lanAvatarPersonId by remember { mutableStateOf<String?>(null) }
    // M4b 1.4 目标选择器（copy|move + 已展开成图片 id 的操作集）
    var pickerType by remember { mutableStateOf<String?>(null) }
    var pickerFileIds by remember { mutableStateOf<List<String>>(emptyList()) }
    // M4b 1.3 新建相册的重名合并确认（相册 + 待执行的 type/fileIds）
    var albumMerge by remember { mutableStateOf<Triple<uniffi.aurora_core.Folder, String, List<String>>?>(null) }
    // M4b 1.4 网格重命名的目标文件（单选菜单项触发；弹窗复用查看器 RenameDialog 形制）
    var renameFileId by remember { mutableStateOf<String?>(null) }
    // 3.2④ 建专题弹窗的目标父级：总览按钮=null（根专题），详情子专题区=当前专题
    var createTopicParent by remember { mutableStateOf<String?>(null) }
    // 4.4 下拉刷新状态（overview 与 browser 共用一个实例：同一时刻只有一个网格在组合）
    val ptrState = remember { PullToRefreshState() }
    // 2026-09-28：平板右侧取色面板的初值快照。面板常驻组合不卸载（收起态 0 宽裁剪），
    // 因此不能把 colorSearchHex 直接当 initialHex 传——面板内拖拽引发的同值回流会重置
    // 拖拽中的 HSV。只在「打开」这一刻取一次当前过滤色。
    var colorPanelInitialHex by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(state.layout.isColorPickerVisible) {
        if (state.layout.isColorPickerVisible) colorPanelInitialHex = colorSearchHex
    }
    // 沉浸态（选择模式/查看器）进入时程序性收起取色面板——与抽屉同口径
    LaunchedEffect(state.selectionMode) { if (state.selectionMode) state.closeColorPicker() }
    LaunchedEffect(tab.viewingFileId) { if (tab.viewingFileId != null) state.closeColorPicker() }

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
    // 本地人物筛选虚拟目录（`__person__:<id>`）的标题，形制同 lanPersonTitle：从本地
    // 人物快照查名。查不到（人物刚被删/快照还没落）退「人物」，不留空标题。
    // 声明必须在 inBrowser 之前——inBrowser 的准入条件要用它。
    val localPersonTitle = tab.folderId?.localPersonIdOrNull()?.let { id ->
        localPeople.firstOrNull { it.id == id }?.name ?: "人物"
    }
    // M6a 阶段 4：LAN 目录网格 = BROWSER + folderId 带 lan 前缀（序列源分流在 reloadImages）
    // M6b 阶段 5：搜索结果/人物成员/专题成员三个人工目录同属 LAN 浏览态（数据源=会话缓存过滤）
    val inLanBrowser = tab.viewMode == ViewMode.BROWSER &&
        (tab.folderId?.lanRemotePathOrNull() != null ||
            tab.folderId == com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID ||
            tab.folderId?.lanPersonIdOrNull() != null ||
            tab.folderId?.lanTopicIdOrNull() != null)
    val inBrowser =
        tab.viewMode == ViewMode.BROWSER &&
            // 本地人物筛选虚拟目录（__person__:<id>）与标签筛选/LAN 虚拟目录同性质：
            // 不是 MediaStore 真文件夹（currentFolder 查不到），漏在这里会掉进 else 的
            // 文件夹总览——2026-10-08 实测点人物卡后整页变回文件夹列表就是这个。
            (currentFolder != null || tagFilterTitle.isNotEmpty() || inLanBrowser ||
                localPersonTitle != null)
    // M4a 3.2 总览：侧栏人物/标签/专题 Section 头部进入；专题详情 = TOPICS_OVERVIEW + activeTopicId
    val inTagsOverview = tab.viewMode == ViewMode.TAGS_OVERVIEW
    val inPeopleOverview = tab.viewMode == ViewMode.PEOPLE_OVERVIEW
    val inTopicsOverview = tab.viewMode == ViewMode.TOPICS_OVERVIEW
    // M4b 阶段 4：画布占位视图（入口已达成，视图本体归 M5）
    val inCanvas = tab.viewMode == ViewMode.CANVAS
    // M6a 阶段 4：LAN 文件夹总览（侧栏网络 Section / 设置 LAN 面板入口）
    val inLanOverview = tab.viewMode == ViewMode.LAN_FOLDERS_OVERVIEW
    // 当前远端目录的标题（优先总览卡片名，找不到退远端 path 尾段；虚拟根=根目录图片）
    val lanBrowserTitle = tab.folderId?.lanRemotePathOrNull()?.let { remotePath ->
        lanOverviewFolders.firstOrNull { it.id == tab.folderId }?.name
            ?: remotePath.substringAfterLast('/').ifEmpty { remotePath }
    }
    // M6a 阶段 5：tag 筛选虚拟目录（lan:__lan_tag__:<tag>）的标题 = 该 tag（非空即命中）
    val lanTagTitle = tab.folderId?.lanTagFilterOrNull()
    // M6b 阶段 5（D40/搜索）：人物成员/专题成员/搜索结果三个人工目录的标题
    val lanPersonTitle = tab.folderId?.lanPersonIdOrNull()?.let { id ->
        lanPeople.firstOrNull { it.id == id }?.name ?: "人物"
    }
    val lanTopicTitle = tab.folderId?.lanTopicIdOrNull()?.let { id ->
        lanTopics.firstOrNull { it.id == id }?.name ?: "专题"
    }
    val inLanSearchResults = tab.folderId == com.aurora.gallery.kotlin.state.LAN_SEARCH_FOLDER_ID
    val inTopicsList = inTopicsOverview && tab.activeTopicId == null
    val inTopicDetail = inTopicsOverview && tab.activeTopicId != null
    val currentTopicName = tab.activeTopicId?.let { id ->
        topics.firstOrNull { it.id == id }?.name
    }
    // 当前详情的专题（3.3 Hero 用；activeTopicId 悬空时详情分支给兜底空态）
    val currentTopic = tab.activeTopicId?.let { id -> topics.firstOrNull { it.id == id } }
    // 3.2④ 两层专题（对齐桌面：顶层只显示根专题 TopicModule:860；子专题区只渲染在根
    // 专题详情 :945/:2072——子专题里没有这个区，子专题不能再建子专题）
    val rootTopics = topics.filter { it.parentId == null }
    val childTopics = tab.activeTopicId?.let { id -> topics.filter { it.parentId == id } } ?: emptyList()
    // 当前详情里的专题是否根专题（子专题详情不渲染子专题区/建子专题入口）
    val currentTopicIsRoot = tab.activeTopicId?.let { id ->
        topics.firstOrNull { it.id == id }?.parentId == null
    } ?: false

    // —— M4a 3.3 专题排序 + 总览搜索（对齐桌面 TopicModule）——
    // 排序：桌面 localStorage `aurora_topic_sort_mode/order` 同语义。M4b 2.1 起并入
    // SettingsStore（旧 `aurora_topics` 键只读迁移）。比较逻辑在 sortTopicsForDisplay。
    val topicSortStore = remember { com.aurora.gallery.kotlin.state.SettingsStore(context) }
    // 人物排序/分组借用同一个 store（SettingsStore 只是 SharedPreferences 的薄壳），
    // 换个变量名只为别把「topic」读进人物的键上
    val personSortStore = topicSortStore
    var topicSort by remember {
        mutableStateOf(
            if (topicSortStore.loadTopicSortByName()) TopicSortOption.NAME else TopicSortOption.TIME,
        )
    }
    var topicSortAscending by remember { mutableStateOf(topicSortStore.loadTopicSortAscending()) }
    // 人物总览的排序/分组（桌面 personSortBy/personSortDirection/personGroupBy 的安卓同位；
    // 默认按数量降序，与桌面 PersonGrid 的 sortBy='count' 一致）
    var personSort by remember { mutableStateOf(personSortStore.loadPersonSortBy()) }
    var personSortAscending by remember { mutableStateOf(personSortStore.loadPersonSortAscending()) }
    var personGroup by remember { mutableStateOf(personSortStore.loadPersonGroupBy()) }
    // 总览搜索：按名称过滤根专题（桌面 topics-overview 的顶栏搜索同款）
    val topicQuery = tab.searchQuery.trim()
    val visibleRootTopics = remember(rootTopics, topicQuery) {
        if (topicQuery.isEmpty()) rootTopics
        else rootTopics.filter { it.name.contains(topicQuery, ignoreCase = true) }
    }
    val sortedRootTopics = remember(visibleRootTopics, topicSort, topicSortAscending) {
        sortTopicsForDisplay(visibleRootTopics, topicSort, topicSortAscending)
    }
    // 子专题横排沿用同一排序（桌面子专题区有独立的排序按钮，平板收敛为一份）
    val sortedChildTopics = remember(childTopics, topicSort, topicSortAscending) {
        sortTopicsForDisplay(childTopics, topicSort, topicSortAscending)
    }

    // 「更多」菜单项（3.2 归入入口 + M4a 4.3 收口的标签三项 + M4b 1.4 文件操作三项；
    // 桌面同位是文件右键菜单 ContextMenu.tsx 的文件分支——「添加到主题 / 编辑标签 /
    // 复制标签 / 粘贴标签 / 重命名 / 复制到 / 移动到」；AI/比较归 M6）：
    //  - 文件夹网格里多选 → 加入专题 / 粘贴标签 / 复制到 / 移动到，单选另有 编辑标签 / 复制标签 / 重命名
    //  - 专题详情里多选 → 从专题移除（对称操作）
    //  - 总览选中的是文件夹卡片 → 复制到 / 移动到 / 删除（成员展开后落写原语）
    // LAN 总览不算本地文件夹总览（选择/目标选择器等本地批量操作对远端目录无意义）
    val inFoldersOverview = !(inBrowser || inTagsOverview || inPeopleOverview || inTopicsOverview || inLanOverview)
    val moreActions = when {
        // M6a 阶段 6：LAN 目录网格的「更多」已接互联态文件操作（lanAllowEdit 直通时出现，
        // 403 门禁态全隐）——重命名/删除/复制到/移动到走远端写路径（LanClient 回写桌面），
        // 选中项身份 = 远端 path（阶段 4 铁律），直接当 paths 传数据层；「加入专题…」是
        // 阶段 5 既有项。本地画布/标签操作（加入画布/编辑标签/复制粘贴标签）对远端仍不
        // 适用，不出现（M4a「不适用的项不出现」先例）。
        inBrowser && inLanBrowser -> buildList {
            if (lanAllowEdit) {
                add(SelectionMoreAction("加入专题…", IconLayout) { showLanTopicPicker = true })
                if (tab.selectedFileIds.size == 1) {
                    add(SelectionMoreAction("重命名…", IconPencil) { lanRenamePath = tab.selectedFileIds.first() })
                }
                add(SelectionMoreAction("删除", IconTrash2) { showDeleteConfirm = true })
                add(SelectionMoreAction("复制到…", IconCopy) { lanPickerMode = LanPickerMode.COPY })
                add(SelectionMoreAction("移动到…", IconFolderInput) { lanPickerMode = LanPickerMode.MOVE })
            }
        }
        inBrowser -> buildList {
            // M5 3.1：画布组置顶（仅平板，D28）。单实例（D21）语义 =「加入画布」，
            // 不做「新建画布」入口；计数显示全画布 N/24，超 24 拦截 Toast
            if (isTablet) {
                add(SelectionMoreAction("加入画布（${canvasStore.count}/24）", IconFrame) {
                    val ids = tab.selectedFileIds
                    when {
                        canvasStore.isFull ->
                            Toast.makeText(context, "画布已满（24/24）", Toast.LENGTH_SHORT).show()
                        canvasStore.count + ids.size > 24 ->
                            Toast.makeText(context, "画布最多 24 张，还可加 ${24 - canvasStore.count} 张", Toast.LENGTH_SHORT).show()
                        else -> {
                            // 加入成功后**直接跳进画布**看装箱结果（2026-09-24 用户反馈）
                            onAddSelectionToCanvas(ids) { added ->
                                if (added) state.openCanvas()
                            }
                        }
                    }
                })
            }
            add(SelectionMoreAction("加入专题…", IconLayout) { showTopicPicker = true })
            // 「添加到人物…」= 桌面文件右键「添加到人物」的触屏同位（多选弹窗 → 写
            // aiData.faces + 人物 count）。紧跟「加入专题…」：两者同为「把选中图归到某个
            // 集合」，相邻好找。WD14 那项保留在下面不动（连桌面时仍可用）。
            add(SelectionMoreAction("添加到人物…", IconBrain) { showPersonPicker = true })
            // 「清除人物信息…」= 桌面文件右键同名项的触屏同位（勾中的人物从这些图上解绑）
            add(SelectionMoreAction("清除人物信息…", IconBrain) { showPersonUnpicker = true })
            if (tab.selectedFileIds.size == 1) {
                add(SelectionMoreAction("编辑标签…", IconTag) { editTagsFileId = tab.selectedFileIds.first() })
                add(SelectionMoreAction("复制标签", IconCopy) { onCopyTags(tab.selectedFileIds) })
            }
            add(SelectionMoreAction("粘贴标签", IconClipboard) { onPasteTags(tab.selectedFileIds) })
            // M6b 阶段 2：AI 入口（桌面 ContextMenu 文件分支同位——AI 分析/AI 重命名）。
            // 未配置 provider 时宿主入口自行友好拦截，菜单项常驻。
            add(SelectionMoreAction("AI 分析…", IconSparkles) { ai.onAnalyze(tab.selectedFileIds.toList()) })
            add(SelectionMoreAction("AI 重命名…", IconSparkles) { ai.onRename(tab.selectedFileIds.toList()) })
            // M6b 阶段 4（D37）：人物识别=图字节卸载桌面 WD14→general 标签进本地词表、
            // character 归组建本地人物（未连接桌面时 VM 内拦截提示）
            add(SelectionMoreAction("AI 人物识别…", IconScanSearch) {
                ai.onWd14PersonPipeline(tab.selectedFileIds.toList())
            })
            add(SelectionMoreAction("复制到…", IconCopy) {
                pickerType = "copy"
                pickerFileIds = tab.selectedFileIds.toList()
            })
            add(SelectionMoreAction("移动到…", IconFolderInput) {
                pickerType = "move"
                pickerFileIds = tab.selectedFileIds.toList()
            })
            if (tab.selectedFileIds.size == 1) {
                add(SelectionMoreAction("重命名…", IconPencil) { renameFileId = tab.selectedFileIds.first() })
            }
        }
        inTopicDetail && tab.activeTopicId != null && tab.selectedFileIds.isNotEmpty() -> buildList {
            if (tab.selectedFileIds.size == 1) {
                add(SelectionMoreAction("编辑标签…", IconTag) { editTagsFileId = tab.selectedFileIds.first() })
                add(SelectionMoreAction("复制标签", IconCopy) { onCopyTags(tab.selectedFileIds) })
                // 桌面「设置专题封面」的触屏同位（桌面在专题卡片右键弹选图器，
                // 平板收敛为「详情里选中一张成员图 → 设为封面」，见 TopicsOverview KDoc）
                add(SelectionMoreAction("设为封面", IconImage) {
                    onSetTopicCover(tab.activeTopicId!!, tab.selectedFileIds.first())
                })
            }
            add(SelectionMoreAction("粘贴标签", IconClipboard) { onPasteTags(tab.selectedFileIds) })
            add(SelectionMoreAction("从专题移除", IconTrash2) {
                onRemoveFromTopic(tab.activeTopicId!!, tab.selectedFileIds)
            })
        }
        inFoldersOverview && tab.selectedFileIds.isNotEmpty() -> buildList {
            // M6b 阶段 2：相册卡片长按选中后的「AI 分析相册」（桌面文件夹右键同位；
            // 扁平 bucket 无递归语义，成员=该相册全部图片）
            add(SelectionMoreAction("AI 分析相册…", IconSparkles) { ai.onFolderAnalyze(tab.selectedFileIds.toList()) })
            add(SelectionMoreAction("复制到…", IconCopy) {
                onResolveSelectionFileIds(tab.selectedFileIds) { ids ->
                    pickerType = "copy"
                    pickerFileIds = ids
                }
            })
            add(SelectionMoreAction("移动到…", IconFolderInput) {
                onResolveSelectionFileIds(tab.selectedFileIds) { ids ->
                    pickerType = "move"
                    pickerFileIds = ids
                }
            })
            add(SelectionMoreAction("删除", IconTrash2) { showDeleteConfirm = true })
        }
        else -> emptyList()
    }

    // 总览数据管道：过滤（搜索词/日期）→ 排序（「根目录图片」恒置顶在 sortFolders 内保证）。
    // remember 键齐备：任一条件变化才重算，文件夹列表量级小、开销可忽略。
    //
    // 2026-10 排序改造：本地总览封面随排序重选——[localCoverOverrides] 是 VM 逐文件夹
    // list_images 重选的结果（缺项 = 无直接子图/虚拟目录，回退 list_folders 的原 cover，
    // 即 modified DESC 口径）。作为 remember 键之一：重算落地即重排显示序列。
    //
    // 2026-10-08 活动时间：folderActivityAt 进 remember 键并喂给 sortFolders 的 date
    // 键（max(内容最新, 活动时间)）——写操作 bump 落地即重排，「操作过就排前面」。
    val displayFolders = remember(
        folders, localCoverOverrides, folderActivityAt,
        tab.searchQuery, tab.dateFilter, state.sortBy, state.sortDirection,
    ) {
        val covered = if (localCoverOverrides.isEmpty()) folders
        else folders.map { f -> localCoverOverrides[f.id]?.let { f.copy(coverUri = it) } ?: f }
        filterFolders(
            sortFolders(covered, state.sortBy, state.sortDirection) { folderActivityAt[it] ?: 0L },
            tab.searchQuery,
            tab.dateFilter,
        )
    }

    // LAN 总览数据管道（M6a 阶段 4）：与本地总览同一条过滤+排序管线（sortFolders 按
    // 「根目录图片」置顶的规则对 __lan_root_images__ 虚拟根天然生效，对齐 React 置顶行为）。
    // 搜索/日期筛选入口在 LAN 视图隐藏，实际是恒等管道；保留形态为的是复用同一组件。
    val displayLanFolders =
        remember(lanOverviewFolders, tab.searchQuery, tab.dateFilter, state.sortBy, state.sortDirection) {
            filterFolders(
                sortFolders(lanOverviewFolders, state.sortBy, state.sortDirection),
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
    val onImageClick: (Image, ImageView) -> Unit = { img, cover ->
        // 编辑模式里点击=勾选，没有查看器可开；正常点击走带过渡的入口
        if (state.selectionMode) state.toggleSelectedInMode(img.id) else onOpenViewer(img, cover)
    }
    val onImageLongPress: (Image) -> Unit = { img ->
        when {
            !state.selectionMode -> state.enterSelectionMode(img.id)
            img.id !in tab.selectedFileIds -> state.rangeSelect(img.id, currentImageIds.value)
            // 已选中项长按 = 打开选中集菜单（M4a 4.3 收口 M1 占位；桌面同位是文件
            // 右键菜单，菜单本体在选择栏「更多」按钮处展开）
            else -> moreExpanded = true
        }
    }
    val onFolderCardClick: (Folder) -> Unit = { folder ->
        if (state.selectionMode) state.toggleSelectedInMode(folder.id) else onFolderClick(folder)
    }
    val onFolderCardLongPress: (Folder) -> Unit = { folder ->
        when {
            !state.selectionMode -> state.enterSelectionMode(folder.id)
            folder.id !in tab.selectedFileIds -> state.rangeSelect(folder.id, currentFolderIds.value)
            // 已选中卡片长按 = 打开选中集菜单（M4b 1.4：复制到/移动到/删除；此前
            // 「更多」在总览是 Toast 占位）
            else -> moreExpanded = true
        }
    }

    // —— 2026-09-28：总览 RV 跨组合存活（修「从文件夹返回主界面会看到主界面刷新一下」）——
    // 总览（FoldersOverview）与文件夹内网格（FileGrid）是互斥分支，进文件夹时总览整块
    // 离开组合 → AndroidView dispose、原生 RecyclerView 销毁；返回时重新 factory，新 RV
    // 配新 adapter（数据为空）→ 全量重绑 + 缩略图重新加载，肉眼就是「刷一下」。
    // 把 RV/adapter/FLIP 状态放到 App 层 remember 里跨组合保留，返回时直接复用同一个
    // RV 实例，卡片与滚动位置原样回来。
    val overviewRvState = remember { FoldersOverviewState() }
    // LAN 总览是 FoldersOverview 的另一个调用点，独立一份，避免两处互相抢同一个 RV
    val lanOverviewRvState = remember { FoldersOverviewState() }
    DisposableEffect(Unit) {
        onDispose {
            overviewRvState.close()
            lanOverviewRvState.close()
        }
    }

    // —— M4a 3.1 / 4.1 侧栏与弹层点标签 = 单选筛选 ——
    // 序列源随之切换（见 GalleryViewModel.reloadImages：有标签 = 全库按标签取，
    // 无标签 = 当前文件夹），取数由组合根那条 LaunchedEffect 统一触发。
    val onTagClick: (String) -> Unit = { tag -> state.toggleTagFilter(tag) }

    // —— 4.3 返回手势链（D5 后：关弹层→关搜索→退选择→返回上级→总览再退=系统默认）。
    // 排序菜单/日期弹层/标签弹层是独立窗口（Dialog/BottomSheet），系统返回先被它们
    // 自己消费，不进本链。
    // M8b 1.2：抽屉收起（手机抽屉行点击/返回键/沉浸态收起共用；幂等——已收不翻转）。
    val closeDrawer: () -> Unit = {
        if (state.layout.isSidebarVisible) state.toggleSidebar()
    }
    // M3 3.1：查看器插在「退选择模式」之前。它自带 dispatchKeyEvent 的梯子（幻灯片→抽屉→
    // 关闭）与 NativeViewerLayer 的 BackHandler，本链在查看器开着时整条让位——
    // 一次 back 只退一层，退的是查看器，不是 goBack()。
    // M8b 1.5：抽屉开着 → 返回先关抽屉（插在链最前；平板无抽屉态，isPhone 恒 false，
    // 条件短路行为与现状逐字一致）。
    BackHandler(
        enabled = tab.viewingFileId == null &&
            (
                (isPhone && state.layout.isSidebarVisible) ||
                    state.layout.isColorPickerVisible ||
                    searchOpen || state.selectionMode || tab.history.canBack
            ),
    ) {
        when {
            isPhone && state.layout.isSidebarVisible -> closeDrawer()

            // 平板右侧取色面板（推挤面板不吃系统返回窗口，必须显式接进链）
            state.layout.isColorPickerVisible -> state.closeColorPicker()

            searchOpen -> {
                // 对齐 React close-android-search：清词 + 关胶囊
                state.setSearchQuery("")
                searchOpen = false
            }

            state.selectionMode -> state.exitSelectionMode()

            else -> state.goBack()
        }
    }

    // M8b-15：pre-IME 返回桥（壳由 onCreate 垫在 content 与 ComposeView 之间）。软键盘
    // 弹出时第一次返回被系统 IME 输入段吃掉（只收键盘，搜索框还在——avd_ai1 实测），
    // Compose BackHandler 属 ViewPostIme 段拿不到那一下；壳的 dispatchKeyEventPreIme
    // 在 ViewPreImeInputStage（早于 IME）到达。判定按 4.3 返回链口径：
    // searchOpen 且查询为空 → 返回键=键盘+搜索框一起关（搜索框消失→失焦→IME 自收）；
    // 有查询词时放行（先收键盘防误丢正在输入的词，再按一次走上面的 BackHandler 链关搜索）；
    // 查看器/手机抽屉/画布态放行——画布有自己的返回梯子（CanvasScreen BackHandler），
    // 本壳在 View 层会抢在它之前（Compose BackHandler 的注册序优先级管不到壳），
    // 不显式守卫会出现「搜索态残留在画布后面，返回被隐形空吃一次」。
    // 键集变化即重注入，lambda 捕获恒新。
    DisposableEffect(
        searchOpen, isPhone, state.layout.isSidebarVisible,
        tab.viewingFileId, tab.searchQuery, inCanvas,
    ) {
        val activity = context as? MainActivity
        activity?.preImeInterceptor?.backHandler = {
            when {
                tab.viewingFileId != null -> false
                inCanvas -> false
                isPhone && state.layout.isSidebarVisible -> false
                searchOpen && tab.searchQuery.isEmpty() -> {
                    state.setSearchQuery("")
                    searchOpen = false
                    true
                }
                else -> false
            }
        }
        onDispose { activity?.preImeInterceptor?.backHandler = null }
    }

    // 3.5 面板开合 / M8b 1.2 形态分叉（D45）：侧栏与主内容两组合同一套（清单 §1.3
    // 组件复用不复制），宿主按形态二选一——
    //  - 平板（isTablet）：SidebarPane 推挤式宽度动画（现状零改动，悬浮卡片壳见下）；
    //  - 手机（isPhone）：PhoneSidebarDrawerHost 平移抽屉——主内容整体 translationX
    //    右移不重排（无 FLIP、FileGrid 列数不变），面板从左缘滑入、边缘手势全程跟手。
    //
    // 悬浮卡片壳（2026-09-26 验收反馈）：对齐 React 桌面主内容区「m-2 + rounded-xl +
    // bg-content」形制——主界面（侧栏+内容）整体内缩 8dp 裁 12dp 圆角，卡片底刷
    // content 色，四周留边透出窗口底 main 色（applyWindowTheme）；底部再让开手势区
    // （navigationBarsPadding），卡片下缘悬在导航栏上方。侧栏 panel 底与 TopBar
    // panel 底都在卡片内被统一裁出圆角；弹窗/弹层是独立 window 不吃这个裁剪；沉浸
    // 态（查看器/画布）insets 清零时卡片自动铺满，留边形制不变。两种形态共用同一卡片。
    // 手机端抽屉行点击后收起（直达目录/总览/设置；平板推挤语义不需要收起，isPhone=false 不触发）
    val sidebarContent: @Composable () -> Unit = {
        // 侧栏文件夹列表用全量 folders：TopBar 搜索词只过滤总览网格（对齐 React
        // 侧栏树不被工具栏搜索过滤）
        TreeSidebar(
            folders = folders,
            currentFolderId = tab.folderId,
            onFolderClick = { onFolderClick(it); if (isPhone) closeDrawer() },
            // 头部点击 = 回主界面（React onNavigateHome，2026-09-20 用户要求）
            onNavigateHome = { state.navigateHome(); if (isPhone) closeDrawer() },
            tagGroups = tagGroups,
            activeTags = tab.activeTags,
            onTagClick = { onTagClick(it); if (isPhone) closeDrawer() },
            // 人物/标签/专题 Section 头部 = 进对应总览（M4a 3.2）
            onPeopleOverviewClick = {
                state.openOverview(ViewMode.PEOPLE_OVERVIEW); if (isPhone) closeDrawer()
            },
            onTagsOverviewClick = {
                state.openOverview(ViewMode.TAGS_OVERVIEW); if (isPhone) closeDrawer()
            },
            onTopicsOverviewClick = {
                state.openOverview(ViewMode.TOPICS_OVERVIEW); if (isPhone) closeDrawer()
            },
            peopleOverviewSelected = inPeopleOverview,
            tagsOverviewSelected = inTagsOverview,
            topicsOverviewSelected = inTopicsOverview,
            foldersOverviewSelected = tab.viewMode == ViewMode.FOLDERS_OVERVIEW,
            // 画布行：点击进画布视图；手机不显示（D28 平板专属）
            showCanvas = isTablet,
            onCanvasClick = { state.openCanvas() },
            canvasSelected = inCanvas,
            // 设置行：打开设置面板（M4b 2.1；手机全屏页打开后抽屉收起）
            onSettingsClick = { onOpenSettings(); if (isPhone) closeDrawer() },
            // 「网络」行未连接点击 = 打开设置直接落在局域网共享页（2026-09-26 验收反馈）
            onLanSettingsClick = { onLanSettingsClick(); if (isPhone) closeDrawer() },
            // 「网络」行已连接点击 = 进 LAN 文件夹总览（2026-09-26 二轮反馈，同「本地相册」）
            onLanOverviewClick = { onLanOverviewClick(); if (isPhone) closeDrawer() },
            lanOverviewSelected = tab.viewMode == ViewMode.LAN_FOLDERS_OVERVIEW,
            // 网络 Section（M6a 阶段 4）：连接状态流 collect 成普通值传入（不轮询）；
            // 远端目录行点击 = 直接进该远端目录网格（folderId 带 lan 前缀，序列源分流
            // 在 reloadImages——与本地目录行的「点行进夹」同位）
            lanConnected = lanSnapshot.state == LanState.CONNECTED,
            lanFolders = lanSnapshot.folders,
            onLanFolderClick = { folder ->
                state.openFolder(com.aurora.gallery.kotlin.state.lanFolderId(folder.path))
                if (isPhone) closeDrawer()
            },
            // M6a 阶段 5（D31 并入口径）：远端词表并入标签 Section、远端人物进人物
            // Section。远端标签行点击 = 进 tag 筛选虚拟目录（与 onLanFolderClick 同款
            // 前缀 folderId，序列源分流在 reloadImages）；远端人物行点击 = 成员筛选
            //（M6b 阶段 5 / D40：GET /api/people/members 端点补齐后转真筛选）
            lanRemoteTagGroups = lanRemoteTagGroups,
            onLanTagClick = { tag ->
                state.openFolder(com.aurora.gallery.kotlin.state.lanTagFolderId(tag))
                if (isPhone) closeDrawer()
            },
            lanPeople = lanPeople,
            onLanPersonClick = { person ->
                ai.onOpenLanPersonFilter(person.id, person.name)
                if (isPhone) closeDrawer()
            },
            // 侧栏人物 Section 的本地人物行：点击进本地成员筛选虚拟目录（形制同上面
            // 远端人物行，但不发网络请求）；手机抽屉下同样点完即收抽屉。
            localPeople = localPeople,
            onLocalPersonClick = { person ->
                onOpenLocalPersonFilter(person.id)
                if (isPhone) closeDrawer()
            },
            browserActive = inBrowser,
            // 面板宽度档（M8b 1.2）：手机抽屉=屏宽 82% 封顶 420dp（与抽屉宿主同源）；
            // 平板推挤沿用 SIDEBAR_WIDTH_DP（256dp）现状
            width = if (isPhone) drawerPanelWidthDp else SIDEBAR_WIDTH_DP,
            modifier = Modifier.fillMaxHeight(),
        )
    }
    // 主内容（选择栏/TopBar + 视图主体）：两种形态共用同一组合。平板经 Row 的 weight
    // 占侧栏外剩余宽（推挤重排）；手机抽屉下 fillMaxSize 恒等卡片宽（平移不重排）。
    val mainContent: @Composable (Modifier) -> Unit = { contentModifier ->
        Column(contentModifier) {
            // 4.2 编辑模式：选择栏替换 TopBar（对齐 React ToolbarPane 的二选一结构）；
            // 画布屏自带顶栏，此处让位（M5 3.4）
            // 4.2 编辑模式：选择栏替换 TopBar（对齐 React ToolbarPane 的二选一结构）；
            // 画布屏自带顶栏（M5 3.4），此处两者都让位
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
                    // M6a 阶段 6：删除键 LAN/本地同态（都进确认弹窗，远端/本地的分流在
                    // 确认回调）；分享仍是本地能力，LAN 拦截提示不变
                    onDelete = { showDeleteConfirm = true },
                    onShare = {
                        if (inLanBrowser) Toast.makeText(context, "局域网图片不支持分享", Toast.LENGTH_SHORT).show()
                        else onShareSelection(tab.selectedFileIds)
                    },
                    onMore = {
                        // 各选择视图的 moreActions 已全部非空（M4b 1.4 收口：总览的
                        // 复制到/移动到/删除），这里只剩空集兜底，不再有 Toast 占位
                    },
                    moreActions = moreActions,
                    moreExpanded = moreExpanded,
                    onMoreExpandedChange = {
                        // M4b 1.4 排查日志：谁在开/关选中集菜单
                        Log.i("AuroraMenu", "moreExpanded -> $it")
                        moreExpanded = it
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else if (!inCanvas) {
                TopBar(
                    title = when {
                        // M6a 阶段 4：LAN 态标题——总览=服务端名（无则「局域网」），目录=远端目录名；
                        // M6a 阶段 5：tag 筛选虚拟目录 =「标签 · <tag>」（照抄本地标签筛选形制）
                        inLanOverview -> lanServerName?.takeIf { it.isNotBlank() } ?: "局域网"
                        lanTagTitle != null -> "标签 · $lanTagTitle"
                        lanPersonTitle != null -> "人物 · $lanPersonTitle"
                        lanTopicTitle != null -> "专题 · $lanTopicTitle"
                        inLanSearchResults -> "搜索结果"
                        inLanBrowser -> lanBrowserTitle ?: "局域网"
                        localPersonTitle != null -> "人物 · $localPersonTitle"
                        tagFilterTitle.isNotEmpty() -> "标签 · $tagFilterTitle"
                        inTagsOverview -> "标签"
                        inPeopleOverview -> "人物"
                        inTopicDetail -> currentTopicName ?: "专题"
                        inTopicsList -> "专题"
                        inCanvas -> "画布"
                        else -> currentFolder?.name ?: "文件夹"
                    },
                    canBack = tab.history.canBack,
                    onBack = { state.goBack() },
                    // 总览是从别处推入历史栈的位置，可退；文件夹总览（栈底）不显示返回键
                    showBack = inBrowser || inTagsOverview || inPeopleOverview || inTopicsOverview ||
                        inCanvas || inLanOverview,
                    sidebarVisible = state.layout.isSidebarVisible,
                    onToggleSidebar = { state.toggleSidebar() },
                    searchQuery = tab.searchQuery,
                    onSearchQueryChange = { state.setSearchQuery(it) },
                    searchOpen = searchOpen,
                    onSearchOpenChange = { searchOpen = it },
                    // 搜索框文案与桌面端逐条对齐（M8b-17，2026-09-28 用户要求；桌面
                    // TopBar.tsx 的 placeholder 链）：①人物/标签总览独占文案；②CLIP 自然语言
                    // 分支在本端无对应状态（Kotlin 语义搜索由 AI 开关承载），不设；③AI 智能
                    // 搜索开=「AI 智能搜索」（settings.aiSmartSearch 同串）；④其余按 scope
                    // 出「搜索文件名…/搜索标签…/搜索文件夹…/搜索…」。旧的两条本端特例文案
                    // （「搜索图片」「搜索专题」）桌面没有，随本次对齐移除。
                    searchPlaceholder = when {
                        inPeopleOverview -> "搜索人物"
                        inTagsOverview -> "搜索标签"
                        ai.searchEnabled -> "AI 智能搜索"
                        tab.searchScope == SearchScope.FILE -> "搜索文件名..."
                        tab.searchScope == SearchScope.TAG -> "搜索标签..."
                        tab.searchScope == SearchScope.FOLDER -> "搜索文件夹..."
                        else -> "搜索..."
                    },
                    // M4b 阶段 3：scope 下拉在 BROWSER（文件夹内/标签筛选）显示，对齐 React 在
                    // people/tags 总览隐藏。M8b-16（2026-09-28 用户要求）：**主界面（文件夹
                    // 总览）与文件夹内保持一致**，一并展示 scope 控件——用户对照两端搜索框
                    // （平板总览缺、手机文件夹内有）要求对齐；React 桌面同样在 folders 总览
                    // 显示该控件（仅 people/tags 总览隐藏），此处补上即与参考实现同口径。
                    // 总览只有「文件夹」一种条目，四种 scope 的匹配都落在文件夹名上
                    // （filterFolders 只按 name 匹配；scope 是标签页级全局态，选后在文件夹内生效）。
                    // 复用上文选择模式段的本地文件夹总览判据；LAN 视图整体排除（搜索入口不提供）。
                    searchScope = tab.searchScope,
                    onSearchScopeChange = { state.setSearchScope(it) },
                    showScope = (inBrowser || inFoldersOverview) && !inLanBrowser,
                    // M6b 阶段 2：AI 搜索开关（与 scope 同域——仅本地 BROWSER；开=回车走
                    // core 改写+全库过滤，桌面 TopBar 紫色图标的触屏同位）
                    aiSearchEnabled = ai.searchEnabled,
                    onAiSearchToggle = ai.onSearchToggle,
                    onAiSearchSubmit = ai.onSearchSubmit,
                    aiSearchBusy = ai.searchBusy,
                    // M6b 阶段 3：取色入口（D39 双入口的 TopBar 半边）；显隐=日期/标签
                    // 同域（纯图片流视图），颜色过滤态高亮按钮+胶囊色点芯片
                    showColorSearch = !inTopicsOverview && !inLanOverview && !inLanBrowser,
                    colorSearchHex = colorSearchHex,
                    onColorSearch = onColorSearch,
                    onClearColorSearch = onClearColorSearch,
                    // 2026-09-28：取色器的形态分宿主——平板走右侧推挤面板（宿主承载），
                    // 手机走 TopBar 内的底部弹层（组件内私有态，此处恒 false）
                    colorPanelOpen = state.layout.isColorPickerVisible,
                    onToggleColorPanel = { state.toggleColorPicker() },
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
                    // M6b 阶段 5：LAN 浏览态放开搜索入口（/api/search 文件名 + AI 开=CLIP
                    // 语义叠加，提交分流在 onLanSearchSubmit）；总览仍无搜索语义
                    showSearch = !inLanOverview,
                    // M6b 阶段 5：LAN 态回车提交分流到 VM（文件名/CLIP 按 AI 开关在 VM 内分流）
                    onLanSearchSubmit = if (inLanBrowser) onLanSearchSubmit else null,
                    // 专题视图下顶栏只留 搜索/返回/侧栏开关（桌面 TopBar :1256/:1521/:1563
                    // 在 topics-overview 隐藏排序/日期/标签，专题自己的排序在页头菜单里）；
                    // 视图切换（grid/adaptive/masonry）= 文件夹网格与专题详情共用
                    showSortMenu = !inTopicsOverview,
                    // 顶栏那颗钮随视图切换排序语义（2026-10-08 指挥官定：进人物界面时顶部
                    // 工具栏按钮要有相应变化）：人物总览给**人物**排序菜单体（按名称/数量/
                    // 创建时间 + 升降 + 分组），页头不再留第二颗；其余视图传 null = 图片排序
                    // 那套。人物总览本来没有图片可排，顶栏沿用图片语义在那儿本就是错的。
                    sortMenuContent = if (inPeopleOverview) ({
                        PersonSortMenuContent(
                            sortBy = personSort,
                            ascending = personSortAscending,
                            groupBy = personGroup,
                            onSortChange = { option, ascending ->
                                personSort = option
                                personSortAscending = ascending
                                personSortStore.savePersonSort(option, ascending, personGroup)
                            },
                            onGroupChange = { group ->
                                personGroup = group
                                personSortStore.savePersonSort(personSort, personSortAscending, group)
                            },
                        )
                    }) else null,
                    showViewMode = inBrowser || inTopicDetail,
                    // LAN 视图隐藏日期/标签筛选（远端项无时间字段；标签弹层是本地词表）
                    showDateFilter = !inTopicsOverview && !inLanOverview && !inLanBrowser,
                    showGroupBy = inBrowser,
                    showTags = !inTopicsOverview && !inLanOverview && !inLanBrowser,
                    // M6a 阶段 4：上传入口只在 LAN 目录网格出现（目标=当前远端目录）；
                    // allow_upload=false 置灰（点击宿主 Toast 提示需桌面端开启）
                    actionIcon = if (inLanBrowser) com.aurora.gallery.kotlin.ui.components.IconUpload else null,
                    actionContentDescription = "上传到此目录",
                    actionEnabled = lanAllowUpload,
                    onActionClick = if (inLanBrowser) {
                        {
                            onLanUploadClick(
                                tab.folderId?.lanRemotePathOrNull()
                                    ?.takeUnless { it == com.aurora.gallery.kotlin.state.LAN_ROOT_IMAGES_ID }
                                    ?: "",
                            )
                        }
                    } else null,
                    // M4c D21：横屏手机侧栏底部「设置」行被裁切不可达，设置入口挂顶栏兜底
                    onOpenSettings = if (isLandscapePhone) {
                        { onOpenSettings() }
                    } else {
                        null
                    },
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
                // 人物总览：远端人物卡网格（M6a 阶段 5，D31）；断线/无远端人物维持空态。
                // 阶段 6：lanAllowEdit 直通时长按菜单加「换头像」——先记目标人物再开
                // AVATAR 模式的目录选择弹窗（选图即走，无目录确认）
                // M6b 阶段 4/5：本地人物半边（WD14 管线产出，D37）+ 远端人物点击转成员筛选（D40）
                inPeopleOverview -> PeopleOverview(
                    lanPeople = lanPeople,
                    lanConnected = lanSnapshot.state == LanState.CONNECTED,
                    lanAllowEdit = lanAllowEdit,
                    localPeople = localPeople,
                    personCoverUris = personCoverUris,
                    thumbnailLoader = thumbnailLoader,
                    personCoverCreatedAt = personCoverCreatedAt,
                    language = language,
                    sortBy = personSort,
                    sortAscending = personSortAscending,
                    groupBy = personGroup,
                    topics = topics,
                    // 排序/分组的改档入口在顶栏（sortMenuContent 注入位），这里只消费状态
                    onPersonClick = { person ->
                        ai.onOpenLanPersonFilter(person.id, person.name)
                    },
                    onRename = { renameLanPersonState = it },
                    onDescribe = { describeLanPersonState = it },
                    onAvatarChange = { person ->
                        lanAvatarPersonId = person.id
                        lanPickerMode = LanPickerMode.AVATAR
                    },
                    // 本地人物：单击进筛选视图，长按出编辑菜单，页头「新建人物」
                    onLocalPersonClick = { person -> onOpenLocalPersonFilter(person.id) },
                    onLocalRename = { renameLocalPersonState = it },
                    onLocalDescribe = { describeLocalPersonState = it },
                    onLocalDelete = { deleteLocalPersonState = it },
                    onLocalSetAvatar = { cropAvatarPerson = it },
                    onCreatePerson = { createPersonOpen = true },
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
                // 专题总览列表（3.2 落地；3.3 页头排序 + 搜索对齐桌面；3.3fix 列数预测防跳档）
                inTopicsList -> TopicsOverview(
                    topics = sortedRootTopics,
                    coverImages = coverImagesById,
                    thumbnailLoader = thumbnailLoader,
                    onTopicClick = { onTopicClick(it) },
                    onCreateTopic = {
                        createTopicParent = null
                        showCreateTopic = true
                    },
                    onRenameTopic = { renameTopicState = it },
                    onDeleteTopic = { deleteTopicState = it },
                    sortOption = topicSort,
                    sortAscending = topicSortAscending,
                    onSortChange = { option, ascending ->
                        topicSort = option
                        topicSortAscending = ascending
                        topicSortStore.saveTopicSort(option == TopicSortOption.NAME, ascending)
                    },
                    sidebarVisible = state.layout.isSidebarVisible,
                    initialScrollAnchor = state.topicsOverviewScrollAnchor,
                    onScrollChanged = { state.topicsOverviewScrollAnchor = it },
                    // M6a 阶段 5：远端专题块（同页追加，D31 并入口径；点击/新建/删除的
                    // 反馈都在宿主）
                    lanTopics = lanTopics,
                    lanConnected = lanSnapshot.state == LanState.CONNECTED,
                    // M6b 阶段 5（D40）：远端专题点击 = 成员筛选虚拟目录（GET /api/topic/members）
                    onLanTopicClick = { topicId ->
                        ai.onOpenLanTopicFilter(topicId.id)
                    },
                    onCreateLanTopic = { showCreateLanTopic = true },
                    onDeleteLanTopic = { deleteLanTopicState = it },
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
                // 专题详情（3.2④ 两层落地；3.3 对齐桌面详情：Hero 头图 + 区块化；
                // 3.3fix 起 Hero/区块头可随滚动收起、图片区整页接续——见 TopicCollapsibleDetail）
                inTopicDetail -> {
                    if (currentTopic == null) {
                        // activeTopicId 悬空（专题被删后的竞态窗口）；reloadTopics 会收敛
                        Column(Modifier.fillMaxWidth().weight(1f)) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Text("专题不存在", color = AuroraTheme.colors.textSecondary)
                            }
                        }
                    } else if (!imagesPending && displayImages.isEmpty()) {
                        // 空态没有滚动主体，头部不需要收起逻辑（pending 期间走下方完整分支，不闪空态）
                        Column(Modifier.fillMaxWidth().weight(1f)) {
                            TopicHero(
                                topic = currentTopic,
                                coverImage = currentTopic.coverFileId?.let { coverImagesById[it] },
                                thumbnailLoader = thumbnailLoader,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            if (currentTopicIsRoot) {
                                TopicChildrenSection(
                                    children = sortedChildTopics,
                                    coverImages = coverImagesById,
                                    thumbnailLoader = thumbnailLoader,
                                    onChildClick = { onTopicClick(it) },
                                    onCreateChild = {
                                        createTopicParent = tab.activeTopicId
                                        showCreateTopic = true
                                    },
                                    onRenameChild = { renameTopicState = it },
                                    onDeleteChild = { deleteTopicState = it },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            TopicSectionHeader(
                                icon = com.aurora.gallery.kotlin.ui.components.IconImages,
                                iconTint = com.aurora.gallery.kotlin.ui.components.TOPIC_SECTION_GREEN,
                                title = "图片",
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Box(
                                Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp),
                                contentAlignment = Alignment.TopCenter,
                            ) {
                                val hasCondition =
                                    tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                                val emptyText = when {
                                    hasCondition -> "无匹配图片"
                                    tagFilterTitle.isNotEmpty() -> "标签「$tagFilterTitle」下没有图片"
                                    else -> "专题里还没有图片"
                                }
                                TopicDashedEmpty(
                                    icon = com.aurora.gallery.kotlin.ui.components.IconImages,
                                    text = emptyText,
                                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                )
                            }
                        }
                    } else {
                        TopicCollapsibleDetail(
                            resetKey = tab.activeTopicId,
                            modifier = Modifier.fillMaxWidth().weight(1f),
                            header = {
                                TopicHero(
                                    topic = currentTopic,
                                    coverImage = currentTopic.coverFileId?.let { coverImagesById[it] },
                                    thumbnailLoader = thumbnailLoader,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                if (currentTopicIsRoot) {
                                    TopicChildrenSection(
                                        children = sortedChildTopics,
                                        coverImages = coverImagesById,
                                        thumbnailLoader = thumbnailLoader,
                                        onChildClick = { onTopicClick(it) },
                                        onCreateChild = {
                                            createTopicParent = tab.activeTopicId
                                            showCreateTopic = true
                                        },
                                        onRenameChild = { renameTopicState = it },
                                        onDeleteChild = { deleteTopicState = it },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                                TopicSectionHeader(
                                    icon = com.aurora.gallery.kotlin.ui.components.IconImages,
                                    iconTint = com.aurora.gallery.kotlin.ui.components.TOPIC_SECTION_GREEN,
                                    title = "图片",
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            },
                            body = { topInsetPx, onScrolled ->
                                // 换专题（根↔子）不卸载详情子树，RV 会带着旧滚动位置；
                                // overlay 架构里头部收起量 = 滚动累计，必须整体重挂对齐
                                key(tab.activeTopicId) {
                                    FileGrid(
                                        images = displayImages,
                                        selectedIds = tab.selectedFileIds,
                                        thumbnailLoader = thumbnailLoader,
                                        onItemClick = onImageClick,
                                        photoRectQuery = viewerPhotoRectQuery,
                                        onItemLongClick = onImageLongPress,
                                        layoutMode = tab.layoutMode,
                                        // 桌面专题图片区无分组（TopicFileGrid 无分组概念）
                                        groupBy = GroupBy.NONE,
                                        level = state.gridLevel,
                                        onLevelChange = { state.gridLevel = it },
                                        // 专题详情同一条网格列数隔离（手机抽屉不重排）
                                        sidebarVisible = gridSidebarVisible,
                                        pullToRefreshState = null,
                                        topInsetPx = topInsetPx,
                                        onScrolled = onScrolled,
                                        modifier = Modifier.fillMaxSize(),
                                    )
                                }
                            },
                        )
                    }
                }
                // M5 1.2：画布屏（专属顶栏 + CanvasView + 沉浸浮钮；顶栏随 CanvasScreen，
                // 通用 TopBar 在画布让位）
                inCanvas -> CanvasScreen(
                    store = canvasStore,
                    dark = darkTheme,
                    thumbnailLoader = thumbnailLoader,
                    sidebarVisible = state.layout.isSidebarVisible,
                    folders = folders,
                    topics = topics,
                    tagGroups = tagGroups,
                    onLoadPickerImages = onLoadPickerImages,
                    onBack = { state.goBack() },
                    onToggleSidebar = { state.toggleSidebar() },
                    onSetImmersive = onSetImmersive,
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
                // 文件夹内网格（选择/查看器共用同一展示序列）
                // M8b-23：空态文案必须等取数落地（!imagesPending）——「还没查完」≠「真的空」，
                // pending 期间走下方网格分支渲染空网格（一小段空白），不再闪「文件夹为空」
                inBrowser -> {                    if (!imagesPending && displayImages.isEmpty()) {
                        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                            val hasCondition = tab.searchQuery.isNotBlank() || tab.dateFilter.start != null
                            val emptyText = when {
                                hasCondition -> "无匹配图片"
                                tagFilterTitle.isNotEmpty() -> "标签「$tagFilterTitle」下没有图片"
                                // 本地人物筛选虚拟目录：文案照标签那条形制（「文件夹为空」
                                // 在这儿是假话——这不是文件夹，是这个人还没加图）
                                localPersonTitle != null -> "人物「$localPersonTitle」下没有图片"
                                // M6a 阶段 4：远端目录（browse 返回的 images 过滤视频后）为空
                                inLanBrowser -> "远端目录为空"
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
                                photoRectQuery = viewerPhotoRectQuery,
                                onItemLongClick = onImageLongPress,
                                layoutMode = tab.layoutMode,
                                groupBy = state.groupBy,
                                level = state.gridLevel,
                                onLevelChange = { state.gridLevel = it },
                                // M8b 1.2：手机抽屉=恒「无侧栏」（列数不随抽屉变）；平板推挤原值
                                sidebarVisible = gridSidebarVisible,
                                pullToRefreshState = ptrState,
                                // M6a 阶段 4：LAN 目录刷新走远端重拉（本地分支走 MediaStore 重扫）
                                onPullToRefresh = if (inLanBrowser) onLanFolderRefresh else onPullRefresh,
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
                // M6a 阶段 4：LAN 文件夹总览——复用 FoldersOverview 组件（同一套卡片网格/
                // 三档捏合/主题），数据 = lanOverviewFolders（__lan_root_images__ 虚拟根置顶，
                // 服务端原序）。目录行点击 = 进远端目录网格（folderId 带 lan 前缀）；长按
                // 禁用（选择/目标选择器等本地批量操作对远端目录无意义）
                inLanOverview -> {
                    Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
                        FoldersOverview(
                            folders = displayLanFolders,
                            thumbnailLoader = thumbnailLoader,
                            // M8b-23②补：与本地总览同走 onFolderClick（→viewModel.openFolder），
                            // 远端目录序列也吃「进夹同步首发」缓存，不再直连 state 绕过
                            onFolderClick = { folder -> onFolderClick(folder) },
                            onFolderLongClick = {},
                            rvState = lanOverviewRvState,
                            level = state.gridLevel,
                            onLevelChange = { state.gridLevel = it },
                            // M8b 1.2：手机抽屉=恒「无侧栏」；平板推挤原值
                            sidebarVisible = gridSidebarVisible,
                            emptyText = if (lanSnapshot.state == LanState.CONNECTED) "桌面端暂无共享目录"
                            else "未连接桌面端（设置 → 局域网共享）",
                            pullToRefreshState = ptrState,
                            onPullToRefresh = onLanRootsRefresh,
                            modifier = Modifier.fillMaxSize(),
                        )
                        PullToRefreshIndicator(
                            state = ptrState,
                            thresholdPx = ptrThresholdPx,
                            modifier = Modifier.fillMaxSize(),
                        )
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
                            // （M8b 1.2：手机抽屉形态恒「无侧栏」，列数不随抽屉开合变）
                            sidebarVisible = gridSidebarVisible,
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
                            // 跨组合保留 RV：返回总览不重建、不重绑、不重新加载缩略图
                            rvState = overviewRvState,
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

    // —— 形态分叉宿主（M8b 1.2）：同一套 sidebarContent/mainContent，两种壳 ——
    if (!isPhone) {
        // 平板：卡片壳 + SidebarPane 推挤式（宽度/动画/重排行为零改动）
        Row(
            Modifier
                .fillMaxSize()
                .navigationBarsPadding()
                .padding(com.aurora.gallery.kotlin.ui.components.APP_CARD_INSET_DP)
                .clip(RoundedCornerShape(12.dp))
                .background(AuroraTheme.colors.content),
        ) {
            SidebarPane(
                visible = state.layout.isSidebarVisible,
                modifier = Modifier.fillMaxHeight(),
            ) {
                sidebarContent()
            }
            mainContent(Modifier.weight(1f).fillMaxHeight())
            // 2026-09-28：右侧取色面板（平板形态；React `RightPanel.tsx` 的安卓取色器
            // 同款推挤容器，与侧栏互斥——见 AppState.toggleColorPicker）
            ColorPickerPane(
                visible = state.layout.isColorPickerVisible,
                modifier = Modifier.fillMaxHeight(),
            ) {
                ColorPickerPanelContent(
                    initialHex = colorPanelInitialHex,
                    onColorChange = onColorSearch,
                    onClose = { state.closeColorPicker() },
                )
            }
        }
    } else {
        // 手机（D45）：查看器/选择模式 = 沉浸态，进入时程序性收起抽屉（手势禁用随
        // gesturesEnabled）；画布手机不可达（D46）。卡片壳由抽屉宿主内部承载——手势层
        // 必须贴到屏幕物理边缘（卡片内缩之外），左缘呼出才接得到 0..8dp 段的起手
        LaunchedEffect(state.selectionMode) { if (state.selectionMode) closeDrawer() }
        LaunchedEffect(tab.viewingFileId) { if (tab.viewingFileId != null) closeDrawer() }
        PhoneSidebarDrawerHost(
            open = state.layout.isSidebarVisible,
            onOpenChange = { target ->
                if (target != state.layout.isSidebarVisible) state.toggleSidebar()
            },
            gesturesEnabled = !state.selectionMode && tab.viewingFileId == null,
            cardInset = com.aurora.gallery.kotlin.ui.components.APP_CARD_INSET_DP,
            sidebar = sidebarContent,
        ) {
            mainContent(Modifier.fillMaxSize())
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

    // M6a 阶段 5 新建网络专题（复用 CreateTopicDialog 形制，标题/按钮标明「网络」）
    if (showCreateLanTopic) {
        CreateTopicDialog(
            title = "新建网络专题",
            confirmLabel = "创建",
            onDismiss = { showCreateLanTopic = false },
            onConfirm = { name ->
                showCreateLanTopic = false
                onCreateLanTopic(name)
            },
        )
    }

    // M4a 4.3 专题重命名（卡片长按菜单触发；同一弹窗组件复用为重命名形制）
    renameTopicState?.let { topic ->
        CreateTopicDialog(
            title = "重命名专题",
            initialName = topic.name,
            confirmLabel = "重命名",
            onDismiss = { renameTopicState = null },
            onConfirm = { name ->
                renameTopicState = null
                onRenameTopic(topic, name)
            },
        )
    }

    // M4a 4.3 专题删除确认（桌面右键「删除」同位；根专题连带子专题一起删）
    deleteTopicState?.let { topic ->
        val childCount = topics.count { it.parentId == topic.id }
        AlertDialog(
            onDismissRequest = { deleteTopicState = null },
            title = { Text("删除专题") },
            text = {
                Text(
                    if (childCount > 0) {
                        "确定删除「${topic.name}」吗？其 $childCount 个子专题将一并删除，图片本身不受影响。"
                    } else {
                        "确定删除「${topic.name}」吗？图片本身不受影响。"
                    },
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleteTopicState = null
                    onDeleteTopic(topic)
                }) {
                    Text("删除", color = Color(0xFFEF4444))
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTopicState = null }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
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

    // 「添加到人物…」：本地人物多选弹窗（桌面 AddToPersonModal 的触屏同位）
    if (showPersonPicker) {
        PersonPickerDialog(
            people = localPeople,
            onDismiss = { showPersonPicker = false },
            onPick = { personIds ->
                showPersonPicker = false
                val fileIds = tab.selectedFileIds.toList()
                onAddFilesToLocalPersons(personIds, fileIds) { ok, failed ->
                    Toast.makeText(
                        context,
                        when {
                            failed == 0 -> "已加入 $ok 张"
                            ok == 0 -> "加入失败（$failed 张）"
                            else -> "已加入 $ok 张（$failed 张失败）"
                        },
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            },
        )
    }

    // 「清除人物信息…」：同一个多选弹窗，确认文案与空态换成解绑语义
    if (showPersonUnpicker) {
        PersonPickerDialog(
            people = localPeople,
            title = "清除人物信息",
            confirmLabel = "解绑",
            emptyHint = "暂无人物。",
            onDismiss = { showPersonUnpicker = false },
            onPick = { personIds ->
                showPersonUnpicker = false
                val fileIds = tab.selectedFileIds.toList()
                onClearPersonsFromFiles(personIds, fileIds) { ok, failed ->
                    Toast.makeText(
                        context,
                        when {
                            failed == 0 -> "已解绑 $ok 张"
                            ok == 0 -> "解绑失败（$failed 张）"
                            else -> "已解绑 $ok 张（$failed 张失败）"
                        },
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            },
        )
    }

    // M6a 阶段 5 远端专题选择弹窗（LAN 目录网格「加入专题…」最后一跳）；
    // 选中项身份 = Image.id = 远端 path（阶段 4 铁律），直接作为 paths 传数据层
    if (showLanTopicPicker) {
        LanTopicPickerDialog(
            topics = lanTopics,
            onDismiss = { showLanTopicPicker = false },
            onPick = { topic ->
                showLanTopicPicker = false
                onAddSelectionToLanTopic(topic.id, tab.selectedFileIds.toList())
            },
            onCreateTopic = {
                showLanTopicPicker = false
                showCreateLanTopic = true
            },
        )
    }

    // M6a 阶段 6 LAN 目录选择弹窗（网格「复制到…/移动到…」与人物卡「换头像」的最后一跳，
    // 接线区对齐上面的 LanTopicPickerDialog）。选中项身份 = 远端 path，move/copy 直接把
    // 选中集当 paths 传数据层；browse/缩略图构造器都是宿主转 GalleryViewModel 的会话
    // 访问器（断线时 lanThumbnailUrlOf 为 null，弹窗图片行退化占位底，不阻塞选择）。
    lanPickerMode?.let { mode ->
        LanFolderPickerDialog(
            mode = mode,
            browse = { path, onReady -> onBrowseLanPath(path, onReady) },
            thumbnailUrlOf = lanThumbnailUrlOf ?: { null },
            onDismiss = { lanPickerMode = null },
            onPickFolder = { dir ->
                lanPickerMode = null
                // MOVE/COPY 都可能有部分失败（逐项语义），汇总与退选择在宿主回调里
                onCopyMoveLanFiles(tab.selectedFileIds.toList(), dir, if (mode == LanPickerMode.MOVE) "move" else "copy")
            },
            onPickImage = { imagePath, _ ->
                lanPickerMode = null
                // AVATAR 点图即走：目标人物在入口（人物卡长按「换头像」）已记下；
                // 悬空防御（正常不可达）直接丢弃，不给半截流程弹第二次
                val personId = lanAvatarPersonId
                lanAvatarPersonId = null
                if (personId != null) onChangeLanAvatar(personId, imagePath)
            },
        )
    }

    // M6a 阶段 5 网络专题删除确认（复用本地删除确认形制；契约无专题重命名端点，
    // 远端卡片的长按菜单本就只有「删除」一项）
    deleteLanTopicState?.let { topic ->
        AlertDialog(
            onDismissRequest = { deleteLanTopicState = null },
            title = { Text("删除网络专题") },
            text = {
                Text(
                    "确定删除网络专题「${topic.name}」吗？其 ${topic.fileCount} 个成员关联将一并解除，图片本身不受影响。",
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleteLanTopicState = null
                    onDeleteLanTopic(topic)
                }) {
                    Text("删除", color = Color(0xFFEF4444))
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteLanTopicState = null }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }

    // M6a 阶段 5 远端人物 重命名 / 改描述（复用既有输入弹窗形制；阶段 6 起「换头像」
    // 也已接线，走 AVATAR 模式的 LanFolderPickerDialog，见上面的 picker 接线区）
    renameLanPersonState?.let { person ->
        LanPersonEditDialog(
            title = "重命名人物",
            initialText = person.name,
            placeholder = "人物名称",
            confirmLabel = "重命名",
            onDismiss = { renameLanPersonState = null },
            onConfirm = { name ->
                renameLanPersonState = null
                onRenameLanPerson(person, name)
            },
        )
    }
    describeLanPersonState?.let { person ->
        LanPersonEditDialog(
            title = "编辑人物描述",
            initialText = person.description.orEmpty(),
            placeholder = "人物描述（留空 = 清空）",
            confirmLabel = "保存",
            // 空串 = 显式清空描述（契约 §3.2 整行写语义），允许空确认
            allowEmpty = true,
            onDismiss = { describeLanPersonState = null },
            onConfirm = { description ->
                describeLanPersonState = null
                onDescribeLanPerson(person, description)
            },
        )
    }

    // —— 本地人物：新建 / 重命名 / 改描述 / 删除确认（桌面 usePeople 手动那一半；
    //    输入弹窗复用 LanPersonEditDialog 形制，确认弹窗复用上面网络专题的形制）——
    if (createPersonOpen) {
        LanPersonEditDialog(
            title = "新建人物",
            initialText = "",
            placeholder = "人物名称",
            confirmLabel = "创建",
            onDismiss = { createPersonOpen = false },
            onConfirm = { name ->
                createPersonOpen = false
                onCreateLocalPerson(name) { ok ->
                    Toast.makeText(
                        context,
                        if (ok) "已创建「$name」" else "创建失败",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            },
        )
    }
    renameLocalPersonState?.let { person ->
        LanPersonEditDialog(
            title = "重命名人物",
            initialText = person.name,
            placeholder = "人物名称",
            confirmLabel = "重命名",
            onDismiss = { renameLocalPersonState = null },
            onConfirm = { name ->
                renameLocalPersonState = null
                onRenameLocalPerson(person, name) { ok ->
                    Toast.makeText(context, if (ok) "已重命名" else "重命名失败", Toast.LENGTH_SHORT).show()
                }
            },
        )
    }
    describeLocalPersonState?.let { person ->
        LanPersonEditDialog(
            title = "编辑人物描述",
            initialText = person.description.orEmpty(),
            placeholder = "人物描述（留空 = 清空）",
            confirmLabel = "保存",
            // 空串 = 显式清空描述（口径同远端人物）
            allowEmpty = true,
            onDismiss = { describeLocalPersonState = null },
            onConfirm = { description ->
                describeLocalPersonState = null
                onDescribeLocalPerson(person, description) { ok ->
                    Toast.makeText(context, if (ok) "已保存" else "保存失败", Toast.LENGTH_SHORT).show()
                }
            },
        )
    }
    deleteLocalPersonState?.let { person ->
        AlertDialog(
            onDismissRequest = { deleteLocalPersonState = null },
            title = { Text("删除人物") },
            text = {
                Text(
                    "确定删除人物「${person.name}」吗？其 ${person.count} 张图的关联将一并解除，图片本身不受影响。",
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    deleteLocalPersonState = null
                    onDeleteLocalPerson(person) { ok ->
                        Toast.makeText(context, if (ok) "已删除" else "删除失败", Toast.LENGTH_SHORT).show()
                    }
                }) {
                    Text("删除", color = Color(0xFFEF4444))
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteLocalPersonState = null }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }

    // 头像裁剪页（桌面 CropAvatarModal 的触屏同位）：开页时拉一次成员图当候选
    cropAvatarPerson?.let { person ->
        LaunchedEffect(person.id) {
            onLoadAvatarCandidates(person.id) { cropAvatarCandidates = it }
        }
        PersonAvatarCropDialog(
            personName = person.name,
            candidates = cropAvatarCandidates,
            initialCoverFileId = person.coverFileId,
            initialFaceBox = person.faceBox,
            loader = thumbnailLoader,
            onCancel = { cropAvatarPerson = null },
            onSave = { fileId, faceBox ->
                cropAvatarPerson = null
                onSaveLocalPersonAvatar(person.id, fileId, faceBox) { ok ->
                    Toast.makeText(
                        context,
                        if (ok) "头像已更新" else "头像保存失败",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            },
        )
    }

    // —— M4b 1.4 目标相册选择器 + 1.3 新建相册（含重名合并拦截）——
    pickerType?.let { type ->
        TargetPickerDialog(
            folders = folders,
            type = type,
            onDismiss = { pickerType = null },
            onPickFolder = { folder ->
                val fileIds = pickerFileIds
                pickerType = null
                onCopyMoveFiles(fileIds, folder.id, type)
            },
            onPickNewAlbum = { name ->
                val fileIds = pickerFileIds
                pickerType = null
                // 细则 iii：与已有相册同名 → 合并确认，不静默合并；确认后并入该相册
                // 实际的 RELATIVE_PATH（可能是 DCIM 等非 Pictures 目录）
                val existing = folders.firstOrNull { it.name == name }
                if (existing != null) albumMerge = Triple(existing, type, fileIds)
                else onCopyMoveToNewAlbum(fileIds, name, type)
            },
        )
    }

    albumMerge?.let { (folder, type, fileIds) ->
        AlertDialog(
            onDismissRequest = { albumMerge = null },
            title = { Text("合并到已有相册") },
            text = {
                Text(
                    "已有同名相册「${folder.name}」（${folder.imageCount} 张）。将把所选 ${fileIds.size} 个文件并入该相册。",
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    albumMerge = null
                    onCopyMoveFiles(fileIds, folder.id, type)
                }) {
                    Text("并入", color = AuroraTheme.colors.primaryDeep)
                }
            },
            dismissButton = {
                TextButton(onClick = { albumMerge = null }) {
                    Text("取消", color = AuroraTheme.colors.textPrimary)
                }
            },
        )
    }

    // M4b 1.4 网格重命名：复用查看器的 RenameDialog 形制（View 体系弹窗，一次性；
    // 从 LaunchedEffect 拉起，先清状态——取消即整条流程结束）
    LaunchedEffect(renameFileId) {
        val fid = renameFileId ?: return@LaunchedEffect
        renameFileId = null
        val currentName = images.firstOrNull { it.id == fid }?.name ?: ""
        RenameDialog(
            context = context,
            currentName = currentName,
            onConfirm = { newName -> onRenameFile(fid, newName) },
        ).show()
    }

    // M6a 阶段 6 LAN 网格重命名：与本地网格重命名同形（同一个 RenameDialog 形制、同款
    // LaunchedEffect 拉起先清状态）；目标名是裸文件名，目录由服务端拼（契约 §1）。
    // LAN 项身份随 rename 迁移（服务端换 path），执行在宿主 onRenameLanFile——查看器内
    // 不做 LAN 重命名是范围决策（身份变化会让查看器序列失效，见 NativeGalleryView 护栏）。
    LaunchedEffect(lanRenamePath) {
        val oldPath = lanRenamePath ?: return@LaunchedEffect
        lanRenamePath = null
        val currentName = images.firstOrNull { it.id == oldPath }?.name ?: ""
        RenameDialog(
            context = context,
            currentName = currentName,
            onConfirm = { newName -> onRenameLanFile(oldPath, newName) },
        ).show()
    }

    // M4a 4.3 编辑标签（长按菜单单选项触发）；保存走 2.1 的唯一写入口
    editTagsFileId?.let { fid ->
        EditTagsDialog(
            fileName = images.firstOrNull { it.id == fid }?.name,
            currentTags = tagsByFile[fid].orEmpty(),
            vocabulary = tagGroups.flatMap { group -> group.tags.map { it.tag } },
            onDismiss = { editTagsFileId = null },
            onSave = { tags ->
                editTagsFileId = null
                onSaveFileTags(fid, tags)
            },
        )
    }

    // M6b 阶段 2：AI 改名提案确认——AI 只产名字（core 不碰库），「应用」才走 M4b
    // 重命名管线（批量授权一次 + renameFiles 的元数据挂住语义）
    ai.renameProposals?.let { proposals ->
        AlertDialog(
            onDismissRequest = ai.onDismissRenameProposals,
            title = { Text("AI 重命名 ${proposals.size} 张") },
            text = {
                Column {
                    proposals.take(30).forEach { (_, oldName, newName) ->
                        Text(
                            "$oldName  →  $newName",
                            fontSize = 13.sp,
                            color = AuroraTheme.colors.textPrimary,
                        )
                    }
                    if (proposals.size > 30) {
                        Text(
                            "…等共 ${proposals.size} 张",
                            fontSize = 13.sp,
                            color = AuroraTheme.colors.textSecondary,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val pairs = proposals.map { (img, _, newName) ->
                        Uri.parse(img.contentUri) to newName
                    }
                    ai.onApplyRenameProposals(pairs) { n ->
                        Toast.makeText(
                            context,
                            if (n > 0) "已重命名 $n 张" else "重命名未生效",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }) { Text("应用") }
            },
            dismissButton = {
                TextButton(onClick = ai.onDismissRenameProposals) { Text("取消") }
            },
        )
    }

    if (showDeleteConfirm) {
        val n = tab.selectedFileIds.size
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("删除所选") },
            text = {
                // LAN 态的删除是远端 DELETE（契约 §1），没有系统相册回收站可找回——
                // 文案不照抄本地那句「可尝试找回」，免得替服务端许诺它给不了的东西
                Text(
                    when {
                        inLanBrowser -> "确定删除所选的 $n 张网络图片吗？删除后不可恢复。"
                        inBrowser || inTopicDetail -> "确定删除所选的 $n 张图片吗？删除后可尝试在系统相册的回收站中找回。"
                        else -> "确定删除所选 $n 个文件夹内的全部图片吗？删除后可尝试在系统相册的回收站中找回。"
                    },
                    color = AuroraTheme.colors.textPrimary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    // M6a 阶段 6：按现成 inLanBrowser 分流——远端 path 过本地 MediaStore
                    // 解析必空，必须在发起前就分开两条链路（身份语义不同）
                    if (inLanBrowser) onDeleteLanSelection(tab.selectedFileIds.toList())
                    else onDeleteSelection(tab.selectedFileIds)
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

/** LAN 上传单次最多张数（系统照片选择器的上限；对齐常见批量体量，超出走多次上传）。 */
private const val LAN_UPLOAD_MAX_ITEMS = 20

/**
 * M8b-15：pre-IME 返回拦截壳（2026-09-27 用户要求「点击搜索时可用返回键关闭搜索框」）。
 * 软键盘弹出时系统把第一次返回派给 IME 输入段（收键盘），Compose 的 BackHandler 在
 * ViewPostIme 段拿不到那一次。本壳垫在 android.R.id.content 与 ComposeView 之间
 * （App 组合根的父级，onCreate 里 setContent 后立即重挂——此刻尚未 attach，零生命周期
 * 扰动），[dispatchKeyEventPreIme] 在 ViewPreImeInputStage（早于 IME）到达。
 * 判定由 App() 组合侧注入 [backHandler]（按 4.3 返回链口径；返回 true=本壳消费，
 * DOWN/UP 一起吞，否则原样放行给 IME→BackHandler 现状链）。
 */
internal class PreImeInterceptorLayout(context: Context) : FrameLayout(context) {
    var backHandler: (() -> Boolean)? = null
    private var swallowUp = false

    override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            when (event.action) {
                // 每次 DOWN 都按当次判定重设标志：被消费的手势吞掉对应 UP，未消费的
                // 手势必须把上一轮可能残留的标志清掉（**UP 不保证回到 pre-IME 通道**，
                // 残留标志会吃掉后续手势的 UP——查看器梯子在 ACTION_UP 动作，实测症状
                // 是「搜索框关过一次之后，查看器返回要按两下」）
                KeyEvent.ACTION_DOWN -> {
                    swallowUp = backHandler?.invoke() == true
                    if (swallowUp) return true
                }
                KeyEvent.ACTION_UP -> if (swallowUp) {
                    swallowUp = false
                    return true
                }
            }
        }
        return super.dispatchKeyEventPreIme(event)
    }
}
