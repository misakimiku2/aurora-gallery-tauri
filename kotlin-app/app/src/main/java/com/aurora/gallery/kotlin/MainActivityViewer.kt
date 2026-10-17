package com.aurora.gallery.kotlin

import android.graphics.RectF
import android.net.Uri
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import com.aurora.gallery.kotlin.canvas.AddResult
import com.aurora.gallery.kotlin.viewer.NativeGalleryView
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import uniffi.aurora_core.Image

// 查看器簇（拆分清单第 31 刀，⑥ 阶段一收官刀）：M3 查看器装配与进出过渡全链——实例
// 单例（ensureViewer）、展开/收缩覆盖层四件（contentWindowRect / predictedViewerRect /
// openViewerFromGrid / mountViewer）、展开窗口返回拦截（双守卫）、退出动画（
// closeViewerWithTransition / closeViewerNow）、Listener 适配器（viewerListener，object
// 表达式 → 查看器协议到宿主的唯一适配面）、FolderPicker 的 folderTreeJson / onViewerNewAlbum、
// 占位 toastSoon——13 个扩展函数（2 internal：ensureViewer / openViewerFromGrid 被.setContent
// 的绑定方法引用与 LaunchedEffect 消费；11 private 仅簇内）。
// viewer / viewerTransition / viewerPhotoRectQuery / viewerEnterAnchor / pendingOpenGuard
// 五个字段留原类降 internal；palette 两成员（maybeAutoExtractPalette / applyPaletteResult，
// 留守）随本刀降 internal 供 Listener 回调；两处 :: 方法引用改 this:: 绑定形式。

internal fun MainActivity.ensureViewer(): NativeGalleryView = viewer ?: NativeGalleryView(this).also {
    it.listener = viewerListener(it)
    // 沉浸态的系统栏/窗口色接管：查看器只发「进/出」，动 flags 与色值一律在宿主
    it.onImmersiveBarsChange = { hidden -> setViewerImmersiveBars(hidden) }
    // 影院态（当前项是视频）的窗口 chrome：同样只发信号，色值归宿主
    it.onStageChromeChange = { black -> applyViewerStageChrome(black) }
    viewer = it
}

/** 内容根（覆盖层所在的容器）在窗口坐标系里的矩形；过渡动画的坐标都从这里起算。 */
private fun MainActivity.contentWindowRect(): RectF? =
    viewerTransition.windowRectOf(findViewById<ViewGroup>(android.R.id.content))
/**
 * 进入动画的预测落点：按库里记的宽高把图 fit-center 到整个窗口。
 *
 * 只是**兜底**。真图一上屏，覆盖层就逐帧改用实测矩形（`ViewerTransition.liveEnd`），
 * 因为元数据的宽高可能被 EXIF 旋转反过来，纯预测会落歪、揭幕那一帧会看到图跳一下。
 *
 * 2026-10-10：**宽高缺失时退回卡片封面的 intrinsic 比例**，不再铺满整屏。原兜底「先按
 * 整屏铺」的后果是：放大动画先撑到整屏，真图上屏后实测矩形与预测差 >8%，
 * `ViewerTransition.refreshEnd` 当场改写落点，用户看到图先铺满、再跳一下缩回来（平板
 * 真机实测）。封面 drawable 就是这张图的缩略图、比例与原图一致，用它算 fit 落点能直接
 * 命中，不必等实测改写。
 *
 * 2026-10-11 补记：远端（LAN）行当时恒走封面兜底，真因**不是**「协议没有宽高」——服务端
 * 自网页客户端时代（2026-03）起就一直随 browse 返回 file_index 真值，是 Kotlin 侧漏解析
 * /漏回填（`lanImageOf` 恒写 null）。现已在数据链补齐（`LanClient.parseItems` →
 * `LanRemoteImage.width/height` → `lanImageOf`），本函数逻辑不变：真值优先，封面兜底保留
 * 给缺值/异常行（EXIF 旋转反向 = 纯预测的既有边界，仍由 refreshEnd 的实测改写兜底）。
 */
private fun MainActivity.predictedViewerRect(image: Image, cover: ImageView?): RectF? {
    val win = contentWindowRect() ?: return null
    var iw = image.width?.toInt() ?: 0
    var ih = image.height?.toInt() ?: 0
    if (iw <= 0 || ih <= 0) {
        val d = cover?.drawable
        if (d != null && d.intrinsicWidth > 0 && d.intrinsicHeight > 0) {
            iw = d.intrinsicWidth
            ih = d.intrinsicHeight
        }
    }
    // 两侧都没有比例（封面还没位图/异常行）：保持原兜底——先按整屏铺，真图上屏后由实测改写
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
internal fun MainActivity.openViewerFromGrid(image: Image, cover: ImageView) {
    val view = ensureViewer()
    val predicted = predictedViewerRect(image, cover)
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
private fun MainActivity.mountViewer(view: NativeGalleryView, fileId: String) {
    disarmPendingOpenGuard()
    view.holdHiddenForTransition = true
    viewModel.appState.openViewer(fileId)
}

private fun MainActivity.armPendingOpenGuard() {
    val host = this
    host.disarmPendingOpenGuard()
    pendingOpenGuard = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            host.viewerTransition.cancel()
            host.disarmPendingOpenGuard()
        }
    }.also { onBackPressedDispatcher.addCallback(it) }
}
private fun MainActivity.disarmPendingOpenGuard() {
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
private fun MainActivity.closeViewerWithTransition(view: NativeGalleryView) {
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
private fun MainActivity.closeViewerNow(view: NativeGalleryView) {
    view.close()
    viewModel.appState.closeViewer()
}
private fun MainActivity.viewerListener(view: NativeGalleryView): NativeGalleryView.Listener {
    val host = this
    return object : NativeGalleryView.Listener {
    override fun onClose(animate: Boolean) {
        // 用户主动退出 = 图片缩回网格卡片（2026-10-08）；animate=false 是删除/移出到空之后
        // 的连带关闭，那张图在网格里已经没了，直接硬关。
        if (animate) host.closeViewerWithTransition(view) else host.closeViewerNow(view)
    }

    /**
     * 3.3：翻页跟到当前这张。不回写的话转屏重建 Activity 后会回到「进入时那张」，
     * 而不是用户正在看的那张。
     * M6b 阶段 3：自动提取触发点——开关开且当前图未提取（缓存无记录）时后台提取，
     * 成败都经 [applyPaletteResult] 回填（成功塞色块、失败置手动重试按钮），无 Toast。
     */
    override fun onNavigate(index: Int) {
        val fileId = view.fileIdAt(index) ?: return
        host.viewModel.appState.viewerNavigated(fileId)
        host.maybeAutoExtractPalette(fileId)
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
            host.viewModel.deleteLanFiles(listOf(fileId)) { ok, fail ->
                Toast.makeText(
                    host,
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
        host.viewModel.resolveSelectionUris(setOf(fileId)) { uris -> requestDelete(uris) }
    }

    /** 3.2 分享：单图版，复用网格那套 ACTION_SEND_MULTIPLE。 */
    override fun onShare(filePath: String) {
        if (filePath.isEmpty()) {
            // 防御分支（正常路径 filePath 恒非空）；文件操作归 M4b
            host.toastSoon("分享", "M4b")
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
            Toast.makeText(host, "保存失败", Toast.LENGTH_SHORT).show()
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
                    host.viewModel.renameFiles(
                        listOf(uris.first() to newName),
                        onDone = { n ->
                            if (n == 0) {
                                Toast.makeText(host, "重命名失败", Toast.LENGTH_SHORT).show()
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
            host.viewModel.saveLanFileUpdates(fileId, tags, description, sourceUrl, sourceUrls) { ok ->
                Toast.makeText(
                    host,
                    if (ok) "已保存" else "保存失败",
                    Toast.LENGTH_SHORT,
                ).show()
            }
            return
        }
        host.viewModel.saveFileUpdates(fileId, tags, description, sourceUrl, sourceUrls) { ok ->
            if (!ok) Toast.makeText(host, "保存失败", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onColorSearch(colorHex: String) {
        host.viewModel.startColorSearch(colorHex)
    }

    override fun onExtractPalette(fileId: String, filePath: String) {
        host.viewModel.extractPalette(fileId, filePath) { hexes ->
            host.applyPaletteResult(fileId, hexes, silent = false)
        }
    }

    /** M6b 阶段 2：查看器「更多 → AI 分析」（本地项；LAN 项菜单不出现该条）。 */
    override fun onAiAnalyze(fileId: String) {
        host.viewModel.startAiAnalysis(listOf(fileId))
    }

    /** 2026-10-11 菜单精简：查看器重命名弹窗的「AI 重命名」按钮（连接 AI 服务器才出现）。 */
    override fun onAiRename(fileId: String) {
        host.viewModel.startAiRename(listOf(fileId))
    }

    /** M6b 阶段 5（D36）：以图搜图——本地图字节 → 桌面 CLIP → 命中进 LAN 搜索结果视图。 */
    override fun onFindSimilar(fileId: String) {
        host.viewModel.findSimilarOnDesktop(fileId) { ok ->
            if (!ok) {
                Toast.makeText(
                    host,
                    "未找到相似图（需连接桌面端且模型/索引就绪）",
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    /** M4b 1.5：查看器「更多」的复制/移动 → FolderPickerDialog（folderTree 从 VM 快照构造）。 */
    override fun onCopyToFolder(fileId: String) {
        view.showFolderPickerDialog("copy", fileId, host.folderTreeJson()) { name ->
            host.onViewerNewAlbum(fileId, name, "copy")
        }
    }

    override fun onMoveToFolder(fileId: String) {
        view.showFolderPickerDialog("move", fileId, host.folderTreeJson()) { name ->
            host.onViewerNewAlbum(fileId, name, "move")
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
        host.viewModel.canvasSourcesFor(listOf(fileId)) { sources ->
            when (val r = host.viewModel.canvasStore.addImages(sources)) {
                is AddResult.Added -> Toast.makeText(
                    host,
                    "已加入画布（${host.viewModel.canvasStore.count}/24）",
                    Toast.LENGTH_SHORT,
                ).show()
                AddResult.AllDuplicates -> Toast.makeText(
                    host, "这张已在画布中", Toast.LENGTH_SHORT,
                ).show()
                AddResult.Full -> Toast.makeText(
                    host, "画布已满（24/24）", Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    /**
     * M6a 阶段 4（D34）：查看器「保存到设备」（仅 LAN 项的菜单项）。
     * VM 下载原文件 → MediaStore Downloads insert；重名自动序号，成功 Toast 带落定名。
     */
    override fun onSaveToDevice(remotePath: String, imageUrl: String) {
        Toast.makeText(host, "正在保存到设备…", Toast.LENGTH_SHORT).show()
        host.viewModel.saveLanImageToDownloads(remotePath, imageUrl) { ok, savedName ->
            Toast.makeText(
                host,
                if (ok) "已保存到下载${savedName?.let { "：$it" } ?: ""}" else "保存失败",
                Toast.LENGTH_LONG,
            ).show()
        }
    }
}
}
/** FolderPickerDialog 的 folderTreeJson：Kotlin 侧是扁平 bucket 列表（D18），全为根节点。 */
private fun MainActivity.folderTreeJson(): String {
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
private fun MainActivity.onViewerNewAlbum(fileId: String, albumName: String, type: String) {
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
private fun MainActivity.toastSoon(feature: String, milestone: String) {
    Toast.makeText(this, "$feature 将随 $milestone 提供", Toast.LENGTH_SHORT).show()
}
