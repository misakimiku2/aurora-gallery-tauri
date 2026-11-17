package com.aurora.gallery.kotlin

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import org.json.JSONArray
import androidx.activity.result.IntentSenderRequest
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewModelScope
import com.aurora.gallery.kotlin.viewer.dialogs.RenameDialog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import uniffi.aurora_core.Folder
import uniffi.aurora_core.deleteIndexEntries
import uniffi.aurora_core.generateId
import uniffi.aurora_core.listImages

// 文件操作宿主执行簇（拆分清单第 27 刀，⑥ 第 2 刀）：M4b 1.1 批量授权（createWriteRequest /
// WRITE 运行时权限 /「所有文件」免弹窗引导 + SP 待执行操作）+ M4b 1.4/1.3 复制/移动宿主执行
// + 4.2 分享/删除，16 个扩展函数落地（§5.1 手法，接收者 MainActivity；12 internal +
// 4 个仅簇内消费的 private：savePendingOp / clearPendingOp / withMediaWriteConsent / performCopyMove）。
// 4 个 registerForActivityResult launcher 与 pendingWriteCallback / pendingDeleteRetry /
// plainWriteConsent / mediaOpPrefs / allFilesGuideShown 字段留在原类（字段落不到扩展上），
// 随本刀降 internal；viewModel 同。原「M4b 1.1 批量授权」分节注释随 launcher 字段留在原类。

/** Q 传统视图（API ≤ 29）的 WRITE 主动请求：**全新安装后若无人请求它**，直写共享
 *  存储抛的是普通 SecurityException——被写闭包静默吞掉，四种文件操作间接全失败
 *  且无提示（2026-10-07 荣耀真机全新安装实测）。READ 授权回调与本函数都会调它。 */
internal fun MainActivity.requestWritePermissionIfNeeded() {
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
internal fun MainActivity.requestWriteAccess(uris: List<Uri>, onGranted: () -> Unit) {
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
internal fun MainActivity.writeConsentFor(buildOp: (List<Uri>) -> JSONObject): (List<Uri>, () -> Unit) -> Unit =
    { blocked, retry ->
        withMediaWriteConsent(buildOp(blocked)) { requestWriteAccess(blocked) { retry() } }
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
internal fun MainActivity.hasAllFilesAccess(): Boolean =
    Build.VERSION.SDK_INT >= 30 && android.os.Environment.isExternalStorageManager()

private fun MainActivity.savePendingOp(op: JSONObject) {
    mediaOpPrefs.edit().putString("pending_op", op.toString()).apply()
}

internal fun MainActivity.consumePendingOp(): JSONObject? =
    mediaOpPrefs.getString("pending_op", null)?.let { raw ->
        mediaOpPrefs.edit().remove("pending_op").apply()
        runCatching { JSONObject(raw) }.getOrNull()
    }

private fun MainActivity.clearPendingOp() {
    mediaOpPrefs.edit().remove("pending_op").apply()
}

/** 待执行操作的统一形态：type=delete/move 用 `uris`；rename 用 `targets`=[[uri,新名]]。 */
internal fun MainActivity.opJson(type: String, uris: List<Uri>): JSONObject =
    JSONObject().put("type", type).put("uris", JSONArray(uris.map { it.toString() }))

/**
 * 被系统拦下时的分流：Android 11+ 且未授予「所有文件访问」→ 弹一次应用内引导，
 * [pendingOp] 先落 SP，用户「去开启」后跳系统设置，回来 [onResume] 消费 SP 重发整批
 * 操作（授予则直写成功，且此后任何照片都不再弹）；「仅本次」/已引导过/低版本 → 清 SP
 * 走 [fallback] 逐张授权（createWriteRequest）。
 */
private fun MainActivity.withMediaWriteConsent(pendingOp: JSONObject, fallback: () -> Unit) {
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
internal fun MainActivity.dispatchPendingOp(op: JSONObject) {
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
internal fun MainActivity.withResolvedUris(fileIds: Collection<String>, op: (List<Uri>) -> Unit) {
    viewModel.resolveFileUris(fileIds) { uris ->
        if (uris.isEmpty()) {
            Toast.makeText(this, "没有可操作的文件", Toast.LENGTH_SHORT).show()
        } else {
            op(uris)
        }
    }
}

// —— M4b 1.4/1.3 复制/移动/重命名的宿主执行（网格与查看器共用一条写入路径）——
// 弹窗层状态（目标选择器/合并确认/重命名目标）在 App() 组合里；这里只提供
// 「已确定目标后的执行」：解析 RELATIVE_PATH、批量授权、调写原语、反馈。

/** 复制/移动到既有相册（folderId 现场解析 RELATIVE_PATH）。 */
internal fun MainActivity.performCopyMoveToFolder(
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
internal fun MainActivity.performCopyMoveToNewAlbum(
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

private fun MainActivity.performCopyMove(
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

/** 4.2 分享：系统分享面板（多图 ACTION_SEND_MULTIPLE，content:// URI + 读授权）。 */
internal fun MainActivity.shareUris(uris: List<Uri>) {
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
internal fun MainActivity.requestDelete(uris: List<Uri>) {
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

// ===== 2026-11-18 文件夹重命名（总览选中集菜单「重命名…」，单选文件夹卡片时出现）=====
//
// 交互口径（用户拍板）：文件夹长按与图片同款——长按=进选择模式，长按已选中项=开
// 选择栏「更多」菜单；重命名是总览分支菜单的一项（第一版锚在卡片上的 MoreMenuPopup
// 弹层被否，形制与图片长按不一致）。菜单项在 App() 的 moreActions 总览分支，经
// onFolderRename 回调落到这里。
//
// 执行 = 逐文件改 RELATIVE_PATH 复用 moveFiles 管线，不走「目录 File.renameTo 整树
// 改名」：后者在 Q legacy 下整夹换 _id，标签/专题/元数据要逐文件搬家，EMUI 扫描回调
// 迟到几十秒；前者 _id 与 content_uri 不变 → file_id 不变 → 元数据零迁移（规划五要点
// ②），授权兜底（writeConsentFor）与「操作过就排前面」的活动时间 bump 全部白得。

/** 「重命名」→ RenameDialog（复用查看器文件重命名同款弹窗；AI 按钮不传——AI 提案
 *  管线读本机图片字节，对文件夹无意义）。 */
internal fun MainActivity.showFolderRenameDialog(folder: Folder) {
    DiagLog.log("[FolderRename] dialog opened folder=${folder.id} name=${folder.name} path=${folder.path}")
    // onConfirm 走命名参数：尾随 lambda 只能绑定声明的最后一个参数，RenameDialog 的
    // 最后一位是 onAiRename（null=不显示 AI 按钮，文件夹重命名不传）——尾随写法会把
    // 确认回调错绑到 AI 按钮上（编译实测踩过）
    RenameDialog(
        context = this,
        currentName = folder.name,
        onConfirm = { newName ->
            DiagLog.log("[FolderRename] confirmed folder=${folder.id} ${folder.name} -> $newName")
            performFolderRename(folder, newName)
        },
    ).show()
}

/**
 * 执行文件夹重命名：bucket X 改名 = 把直属文件（`list_images` 只取 parent_id 直属行，
 * 子相册不在内）逐个移到 `X'`。旧 RELATIVE_PATH 由 resolveFolderRelPath 现场解析
 * （总览快照 Folder.path 换前缀，零成本），名字合法性见 [deriveRenamedRelPath]。
 *
 * 根目录散图（path = 外部存储根 → relPath `/`）不可改名；被系统拦下的行走
 * writeConsentFor（「所有文件」引导或 createWriteRequest，SP 待执行操作的 move 回放
 * 路径现成）。
 *
 * 2026-11-18 二轮修复（用户实测三报障）：
 *  - 置顶：moveFiles 传 dateModifiedPreserve 保真内容时间 + bumpActivity=false；
 *  - 卡片名字要等好几秒：索引 Folder 行只有全量对账才重写，单行 upsert 不建卡——
 *    onSettled（moveFiles 内部收尾完成）后做乐观补丁，卡片就地换名换路径；
 *  - 旧卡片空壳滞留：bucket 变了（legacy 重建行）时旧 Folder 行 count 归 0 但要等
 *    对账才清，就地摘除。
 */
internal fun MainActivity.performFolderRename(folder: Folder, newName: String) {
    viewModel.resolveFolderRelPath(folder.id) { oldRel ->
        val newRel = oldRel?.let { deriveRenamedRelPath(it, newName) }
        when {
            oldRel == null -> Toast.makeText(
                this,
                if (folder.path.startsWith(
                        android.os.Environment.getExternalStorageDirectory().absolutePath,
                    )
                ) {
                    "无法解析文件夹路径"
                } else {
                    // 八轮 Movies 实案：/hw_product 预置媒体（固件分区，只读）也会进
                    // MediaStore 出卡片——「无法解析」让人摸不着头脑
                    "系统只读目录（${folder.path}）不能重命名"
                },
                Toast.LENGTH_LONG,
            ).show()
            // oldRel 有值而 newRel 为 null 只剩两种：根目录（"/"）或名字非法（改名弹窗
            // 已挡空名/同名，这里兜改不出合法路径的残局）
            newRel == null -> Toast.makeText(
                this,
                if (oldRel == "/") "根目录（散图）不能重命名" else "文件夹名不能包含 / \\ 等路径字符",
                Toast.LENGTH_SHORT,
            ).show()
            else -> viewModel.resolveSelectionFileIds(setOf(folder.id)) { ids ->
                viewModel.resolveFileUris(ids) { uris ->
                    DiagLog.log("[FolderRename] begin rel=$oldRel -> $newRel uris=${uris.size}/${ids.size}")
                    if (uris.isEmpty()) {
                        Toast.makeText(this, "文件夹为空或无法读取", Toast.LENGTH_SHORT).show()
                        return@resolveFileUris
                    }
                    // 改前卡片快照（主线程）：乐观补丁的锚（计数/封面/时间全沿用）
                    val oldCard = viewModel.folders.value.firstOrNull { it.id == folder.id } ?: folder
                    val newAbsPath = java.io.File(folder.path).parentFile
                        ?.let { java.io.File(it, newName).absolutePath }
                        ?: (folder.path.trimEnd('/') + "/" + newName)
                    // 桥接早置（六轮）：改名是逐行迁移（大文件夹 ~10s），确认瞬间就把卡片
                    // 换成新名/新路径的桥接卡，迁移期所有中间刷新由 mergeRenameBridge 维稳
                    // （旧壳摘除、桥接卡补回）——迁移对用户完全不可见
                    val bridgeCard = oldCard.copy(name = newName, path = newAbsPath)
                    viewModel.renameBridges[oldCard.id] = RenameBridge(bridgeCard, folder.path)
                    viewModel.folders.value = viewModel.folders.value.map {
                        if (it.id == oldCard.id) bridgeCard else it
                    }
                    viewModel.viewModelScope.launch {
                        // 逐行预抓改前行时间戳（DATE_MODIFIED + DATE_ADDED）：移动/改行会让
                        // provider 把两列刷成 now/登记时刻，而总览时间排序键 = max(createdAt,
                        // 活动时间)（GridModels.sortFolders，createdAt=MAX(DATE_ADDED)）——
                        // 两列都不保真改个名就置顶。DATE_ADDED 实测无法经 update 写回
                        // （provider 对 app 丢弃该列），除行级追写外还要按新路径登记进
                        // renamedRowStamps，让每次对账聚合前重灌（见 GalleryViewModel 字段 doc）
                        val preserve = HashMap<String, MovedRowStamps>()
                        val pathStamps = HashMap<String, MovedRowStamps>()
                        var liveCount = 0
                        withContext(Dispatchers.IO) {
                            for (uri in uris) {
                                val stamps = viewModel.queryRowStamps(uri) ?: continue
                                preserve[uri.toString()] = stamps
                                // 新绝对路径 = 新目录 + 旧文件名（renameTo/RELATIVE_PATH 语义：文件名不变）
                                viewModel.queryDataPath(uri)?.let { data ->
                                    pathStamps["$newAbsPath/${data.substringAfterLast('/')}"] = stamps
                                    if (java.io.File(data).exists()) liveCount++
                                }
                            }
                        }
                        viewModel.renamedRowStamps.putAll(pathStamps)
                        DiagLog.log("[FolderRename] stamps registered n=${pathStamps.size} live=$liveCount")
                        viewModel.moveFiles(
                            uris,
                            newRel,
                            onDone = { n ->
                                DiagLog.log("[FolderRename] moved=$n/${uris.size} -> $newRel")
                                Toast.makeText(
                                    this@performFolderRename,
                                    when {
                                        n <= 0 -> "重命名失败"
                                        // 全空壳（八轮 QQ 实案：54 条记录的文件体早已不在
                                        // ——QQ 自己清的，MediaStore 死行残留）：改名实为
                                        // 死行清理，卡片会随 finalize 摘除。「已重命名」
                                        // 配上文件夹消失＝用户当数据丢失恐慌
                                        liveCount == 0 ->
                                            "空壳文件夹已清理：${uris.size} 条记录的文件早已不存在"
                                        else -> "已重命名"
                                    },
                                    Toast.LENGTH_LONG,
                                ).show()
                                if (n > 0) {
                                    // 改名完成即退出选择态：选中集里是旧 folder id，卡片
                                    // 已随改名消失，留着是幽灵选择
                                    viewModel.appState.exitSelectionMode()
                                } else {
                                    // 改名失败：拆桥复位（桥接卡是当前唯一显示态，不拆会
                                    // 以新名挂在旧内容上）
                                    viewModel.renameBridges.remove(oldCard.id)
                                    viewModel.folders.value = viewModel.folders.value.map {
                                        if (it.id == oldCard.id) oldCard else it
                                    }
                                }
                            },
                            onBlocked = writeConsentFor { blocked ->
                                opJson("move", blocked).put("relPath", newRel)
                            },
                            // 改名不 bump「操作过就排前面」：时间排序下改个名不该把卡片顶到最上面
                            bumpActivity = false,
                            dateStampsPreserve = preserve,
                            onSettled = { finalizeFolderRename(oldCard, newName, newAbsPath, newRel, uris, liveCount) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * 改名收尾（moveFiles 内部收尾**完成之后**经 onSettled 调，2026-11-18 二轮）：
 *  1. 新 folder id 现查：新路径下的行 BUCKET_ID（legacy 重建行走新 bucket；update
 *     路径 bucket 稳定 → 与旧 id 同值，Q legacy 实测 provider 更新 relative_path
 *     不重算 bucket_id，folder 身份天然延续）。
 *  2. 卡片乐观补丁：就地换名/换路径（bucket 变了则整体换 id），计数/封面/时间全
 *     沿用改前卡片——索引 Folder 行要等对账才重写（单行 upsert 不建卡），不补丁
 *     卡片名要挂好几秒。补丁与对账幂等（对账稍后以权威数据覆盖同一结果）。
 *  3. 旧 Folder 行摘除：bucket 变了且旧 bucket 里已无直属行（部分失败时不摘，那
 *     不是死行）——否则旧卡片以 count=0 空壳挂到对账为止。
 *  4. 活动时间过户 + 旧目录空则清理。
 */
private fun MainActivity.finalizeFolderRename(
    oldCard: Folder,
    newName: String,
    newAbsPath: String,
    newRel: String,
    uris: List<Uri>,
    liveCount: Int,
) {
    viewModel.viewModelScope.launch(Dispatchers.IO) {
        // 新 folder id 现查，两段式：
        //  ① update 路径（Q legacy bucket 稳定/R+）：行 uri 不变，直接按 uri 查；
        //  ② legacy 重建路径：旧 uri 已删，按新目录前缀跨图片/视频集合查——移动的
        //     行可能是视频（图片集合查不到），必须两集合都扫。
        // 重建行登记是异步的（registerRow 协程还在等扫描回调，100~300ms+），finalize
        // 可能跑在它前面——有活行的文件夹短轮询等它落地，查不到才会落「幽灵」分支
        // （2026-11-18 五轮：Oplayer 改名卡片消失好一会，就是轮询缺失时误判幽灵）。
        fun lookupNewId(): String? =
            runCatching {
                uris.firstNotNullOfOrNull { viewModel.queryBucketId(it) }
            }.getOrNull() ?: runCatching {
                listOf(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                ).firstNotNullOfOrNull { coll ->
                    contentResolver.query(
                        coll,
                        arrayOf(MediaStore.MediaColumns.BUCKET_ID),
                        "${MediaStore.MediaColumns.DATA} LIKE ?",
                        arrayOf("$newAbsPath/%"),
                        null,
                    )?.use { c ->
                        if (c.moveToFirst()) generateId(c.getLong(0).toString()) else null
                    }
                }
            }.getOrNull()
        var newFolderId = lookupNewId()
        if (newFolderId == null && liveCount > 0) {
            var attempts = 0
            while (newFolderId == null && attempts < 5) {
                delay(250)
                newFolderId = lookupNewId()
                attempts++
            }
        }
        DiagLog.log("[FolderRename] settled oldId=${oldCard.id} newId=$newFolderId rel=$newRel live=$liveCount")

        // 旧 bucket 里若还有直属行（部分失败/非媒体遗留索引），旧 Folder 行不是死行，不摘
        val oldBucketEmpty = withContext(Dispatchers.IO) { listImages(oldCard.id).isEmpty() }

        // 全死行（没有任何活行落到新路径）：文件夹本就不在盘上——清桥接 + 卡片就地
        // 消失（死行的 MediaStore 行/索引行已在 moveFiles 摘除）。有活行时卡片由桥接
        // 维稳到对账落地（mergeRenameBridge 自愈），这里不再动 folders.value。
        if (liveCount == 0 && newFolderId == null) {
            viewModel.renameBridges.remove(oldCard.id)
            withContext(Dispatchers.Main) {
                viewModel.folders.value = viewModel.folders.value.filter { it.id != oldCard.id }
                // 卡片就地消失必须有解释（八轮 QQ 实案：用户只看到文件夹没了，刷新
                // 也不回来，当数据丢失报障）——onDone 的 toast 可能已被顶掉，这里再
                // 落一句结论
                Toast.makeText(
                    this@finalizeFolderRename,
                    "「${oldCard.name}」是空壳（文件早已不存在），已就地清理",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
        // 旧 Folder 行摘除：bucket 变了（legacy 重建）或全死行（新 id 查不到）且旧 bucket
        // 已无直属行（部分失败时还有活行挂着，不摘，那不是死行）
        if (oldBucketEmpty && (newFolderId == null || newFolderId != oldCard.id)) {
            runCatching { deleteIndexEntries(listOf(oldCard.id)) }
                .onFailure { Log.w(GalleryViewModel.TAG, "[FolderRename] old folder row delete failed: ${oldCard.id}", it) }
        }
        viewModel.transferFolderActivity(oldCard.id, newFolderId ?: oldCard.id)

        // 部分失败兜底：迁移全部结束（含异步 registerRow）后旧 bucket 仍有行 → 改名
        // 部分失败，桥接不能一直压着旧卡（里面的行会从 UI 消失）——拆桥让新旧两卡
        // 如实显示。全量迁移完成（旧 bucket 空）的文件夹走 mergeRenameBridge 自愈，
        // 不经过这里。
        if (liveCount > 0 && !oldBucketEmpty) {
            viewModel.viewModelScope.launch(Dispatchers.IO) {
                delay(20_000)
                val stillHasRows = listImages(oldCard.id).isNotEmpty()
                if (stillHasRows && viewModel.renameBridges.remove(oldCard.id) != null) {
                    DiagLog.log("[FolderRename] partial-failure bridge teardown oldId=${oldCard.id}")
                }
            }
        }

        // 旧 bucket 目录清空后的就地删除（best-effort）：File.delete 只对空目录成功——
        // 还压着子相册（嵌套 bucket 的行仍指向其下）或非媒体文件时静默保留，这正是
        // 嵌套场景的正确行为
        val dir = java.io.File(oldCard.path)
        val removed = runCatching {
            dir.isDirectory && dir.list()?.isEmpty() == true && dir.delete()
        }.getOrDefault(false)
        DiagLog.log("[FolderRename] old-dir cleanup ${dir.absolutePath} removed=$removed patched=${newFolderId != null}")
    }
}

/**
 * 由旧 RELATIVE_PATH 派生改名后的新 RELATIVE_PATH（纯函数，单元测试钉住）。
 * `Pictures/X/` + `Y` → `Pictures/Y/`；顶层 `X/` → `Y/`。根（`/`，根目录散图）与
 * 非法名字（空 / `.` / `..` / 含路径分隔符）返回 null，由调用方提示不执行。
 */
internal fun deriveRenamedRelPath(oldRelPath: String, newName: String): String? {
    if (oldRelPath == "/") return null
    val name = newName.trim()
    if (name.isEmpty() || name == "." || name == ".." ||
        name.contains('/') || name.contains('\\')
    ) {
        return null
    }
    val parent = oldRelPath.trimEnd('/').substringBeforeLast('/', missingDelimiterValue = "")
    return if (parent.isEmpty()) "$name/" else "$parent/$name/"
}

