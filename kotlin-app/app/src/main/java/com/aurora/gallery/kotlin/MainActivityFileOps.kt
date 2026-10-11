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
import org.json.JSONObject

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

