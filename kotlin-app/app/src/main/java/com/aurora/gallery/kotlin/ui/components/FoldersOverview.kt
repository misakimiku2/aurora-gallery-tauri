package com.aurora.gallery.kotlin.ui.components

import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.doOnLayout
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.aurora_core.Folder
import kotlin.math.max

/** 简化文件夹图标（material-icons-core 无 Folder，自行绘制，对齐 lucide Folder）。 */
private val FolderIcon: ImageVector by lazy {
    ImageVector.Builder(
        name = "Folder",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(fill = SolidColor(Color.Black)) {
            moveTo(2f, 6f)
            curveTo(2f, 4.9f, 2.9f, 4f, 4f, 4f)
            lineTo(9f, 4f)
            lineTo(11f, 6f)
            lineTo(20f, 6f)
            curveTo(21.1f, 6f, 22f, 6.9f, 22f, 8f)
            lineTo(22f, 18f)
            curveTo(22f, 19.1f, 21.1f, 20f, 20f, 20f)
            lineTo(4f, 20f)
            curveTo(2.9f, 20f, 2f, 19.1f, 2f, 18f)
            close()
        }
    }.build()
}

/**
 * 文件夹总览主视图（原生 RecyclerView + GridLayoutManager，对齐系统相册滚动性能）。
 */
@Composable
fun FoldersOverview(
    folders: List<Folder>,
    thumbnailLoader: ThumbnailLoader,
    onFolderClick: (Folder) -> Unit,
    /** 长按回调（4.1）：总览进选择模式 / 范围选择，语义同 FileGrid（宿主侧决定）。 */
    onFolderLongClick: (Folder) -> Unit = {},
    modifier: Modifier = Modifier,
    /**
     * 三档捏合档位：0=小、1=中、2=大（默认中档）。
     * 由应用级状态传入（3.1 `AppState.gridLevel`，L2 修复）：与 FileGrid 共享同一档位，
     * 进文件夹/返回总览不再重置，写回经 [onLevelChange]，本组件不持有档位。
     */
    level: Int = 1,
    onLevelChange: (Int) -> Unit = {},
    /**
     * 返回总览时恢复的滚动位置（对齐 React 版 `HistoryItem.scrollTop` 的恢复行为）。
     * 本组件因导航离开组合再回来时 RV 是全新的，由宿主把离开前记录的位置传回；
     * 只在本次组合实例消费一次，之后的重扫/重组不再重复归位。
     */
    initialScrollTop: Int = 0,
    /** 滚动位置上报（每滚动帧调用；宿主用普通字段记录，见 [AppState.overviewScrollTop]）。 */
    onScrollChanged: (Int) -> Unit = {},
    /** 空态文案：宿主按「有搜索/筛选条件」区分「无匹配文件夹」与「暂无文件夹」。 */
    emptyText: String = "暂无文件夹",
    /** 3.5 侧栏目标状态：用于开合动画期间的列数预测（同 FileGrid）。 */
    sidebarVisible: Boolean = false,
    /** 选中集合（4.1/4.2）：FolderAdapter 按 id 差量刷新边框/角标。 */
    selectedIds: Set<String> = emptySet(),
    /** 4.4 下拉刷新状态（宿主创建并渲染指示器）；null = 不启用。 */
    pullToRefreshState: PullToRefreshState? = null,
    /** 4.4 刷新动作：宿主触发扫描，完成时回调 [onComplete]（指示器落勾）。 */
    onPullToRefresh: ((onComplete: () -> Unit) -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    val currentSelectedIds = rememberUpdatedState(selectedIds)

    // 进度驱动 FLIP（与 FileGrid 同一套手感：捏合 = FLIP 动画的进度条）。
    // 必须定义在 gridAdapter 之前——gridAdapter 与下面的 AndroidView 都要用。
    val rvHolder = remember { RvHolder() }
    val pinchFlip = remember { PinchFlipController() }
    // 捏合换档的锚点透传：onPinchEnd 记录 → update 消费（一次）。落档必须保持同一锚点
    // 停在同一屏幕位置（含末端钳制位移 δ 后的 commitAnchorTop），预览与收尾 FLIP 才
    // 无缝衔接——此前没透传，animateSpanChange 退回 firstVisible 锚点，与 FileGrid 不一致。
    val pendingPinchAnchor = remember { AnchorOverrideHolder() }
    // 收尾动画时长：捏合换档时按剩余进度缩短，用后即复位
    var flipDurationMs by remember { mutableLongStateOf(FLIP_DURATION_MS) }

    // 长按回调转发最新引用（同 FileGrid：adapter 的 remember 只捕获首帧 lambda）
    val currentOnFolderLongClick = rememberUpdatedState(onFolderLongClick)
    // 4.4 下拉刷新动作同理（factory 闭包只创建一次）
    val currentOnPullToRefresh = rememberUpdatedState(onPullToRefresh)

    val gridAdapter = remember(pinchFlip) {
        FolderAdapter(
            loader = thumbnailLoader,
            surfaceColor = colors.surface.toArgb(),
            textPrimaryColor = colors.textPrimary.toArgb(),
            textSecondaryColor = colors.textSecondary.toArgb(),
            onClick = onFolderClick,
            onLongClick = { currentOnFolderLongClick.value(it) },
        ).also { it.pinchFlip = pinchFlip }
    }

    LaunchedEffect(folders) {
        gridAdapter.submit(folders)
        // notifyDataSetChanged 会把 RV 打回顶部（重扫/数据替换场景），记忆同步归零；
        // 返回总览的恢复（pendingRestore>0）在其后的布局回调里执行，会覆盖这里的值
        onScrollChanged(0)
    }

    LaunchedEffect(selectedIds) {
        gridAdapter.updateSelection(currentSelectedIds.value)
    }

    // 滚动位置恢复：本次组合实例消费一次。submit 之后注册 doOnLayout——首个带数据的
    // 布局完成后 scrollBy 归位（LinearLayoutManager 按需填充，一步可滚到位），避免
    // 对着空内容滚；消费完置 0，重扫/重组不会重复归位。
    var pendingRestore by remember { mutableIntStateOf(initialScrollTop) }
    LaunchedEffect(Unit) {
        if (pendingRestore > 0) {
            val target = pendingRestore
            rvHolder.rv?.doOnLayout { rv ->
                pendingRestore = 0
                rv.scrollBy(0, target)
            }
        }
    }

    DisposableEffect(gridAdapter) {
        onDispose { gridAdapter.cancel() }
    }

    if (folders.isEmpty()) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    imageVector = FolderIcon,
                    contentDescription = null,
                    tint = colors.textSecondary,
                    modifier = Modifier.size(48.dp),
                )
                Text(
                    text = emptyText,
                    fontSize = 14.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
        return
    }

    val isTablet = LocalConfiguration.current.screenWidthDp >= 600
    val gapPx = context.dp(if (isTablet) 16 else 10)
    val paddingPx = context.dp(if (isTablet) 24 else 8)

    // 3.5 预测收敛（同 FileGrid）：侧栏开合动画是纯 layout 变化、不触发重组，列数若等
    // 动画结束才收敛会与面板脱节（卡片突变）。动画进行中（sidebarVisible 与已同步状态
    // 不一致）按目标状态的最终宽度预测列数，点按瞬间一次收敛、与面板动画同步。
    val density = LocalDensity.current
    val currentSidebarVisible = rememberUpdatedState(sidebarVisible)
    val sidebarSynced = remember { mutableStateOf(sidebarVisible) }
    val spanSyncTick = remember { mutableIntStateOf(0) }

    // 三档捏合：档位是应用级状态（AppState.gridLevel），这里只读参数 + 写回回调
    val currentLevel = rememberUpdatedState(level)
    // factory 闭包只创建一次，gapPx 直接捕获会在旋转（平板/手机间距变化）后读到旧值。
    val currentGapPx = rememberUpdatedState(gapPx)
    val decoration = remember { GridSpacingDecoration(6, gapPx) }

    // 容器宽度（dp）：doOnLayout 首次布局后写入，强制 update 重跑（对齐 FileGrid 的
    // 3.2fix——update 在 RV 布局完成前 width=0 提前返回后，必须有下一次重跑的触发源，
    // 否则 applyCellWidth 永远量不出单元格宽度）。
    var measuredWidthDp by remember { mutableIntStateOf(0) }
    // 组合期建立订阅（2026-09-20 修复）：update 是 AndroidView 的非观察 lambda，其中的
    // state 读取不订阅快照；不在这里读一次，doOnLayout 的首次量宽写入不会触发重组，
    // update 就再也没有重跑时机——冷启动列数停在 factory 的屏宽兜底值（实测 6 列/299px
    // 卡片，正确为 5 列/365px），直到任意一次无关的状态变化才「顺带」收敛。FileGrid 在
    // 组合期读 containerWidthDp 所以无此问题。
    @Suppress("UNUSED_VARIABLE") val measuredWidthDpSubscribed = measuredWidthDp

    AndroidView(
        factory = { ctx ->
            // 初始列数按**内容宽**（扣除侧栏）算（2026-09-20 用户报障修复）：此前用整屏宽
            // 兜底，侧栏展开时首帧列数偏大（6 列），进入/返回总览后先见 6 列布局、重组才
            // 收敛到 5 列（FLIP 重排 + 滚动恢复落在错误几何上 → 位置漂移）。组合时侧栏
            // 状态是静态的（开合动画前/后都在此值上），扣除即可首帧就对。
            val sidebarPx = if (sidebarVisible) with(density) { SIDEBAR_WIDTH_DP.roundToPx() } else 0
            val initialWidthPx = (ctx.resources.displayMetrics.widthPixels - sidebarPx).coerceAtLeast(1)
            val initialCols = targetCols(ctx.pxToDp(initialWidthPx), level)
            decoration.spanCount = initialCols
            // 先建 LM 以便挂 previewRestorer：捏合期间任何布局（如换档）都会把手动的
            // 预览几何洗掉，必须在布局末尾重放（对齐 FileGrid）
            val gridLayoutManager = AuroraGridLayoutManager(ctx, initialCols).apply {
                previewRestorer = { rvHolder.rv?.let { pinchFlip.reapplyPreview(it) } }
            }
            RecyclerView(ctx).apply {
                layoutManager = gridLayoutManager
                adapter = gridAdapter
                addItemDecoration(decoration)
                setPadding(paddingPx, paddingPx, paddingPx, paddingPx)
                clipToPadding = false
                // 裁剪双保险（对齐 FileGrid）：滚出 RV 顶边的内容不得画进 TopBar——Compose
                // interop 链路默认不裁剪，捏合预览的手动 layout 与 FLIP 位移都会把卡片摆到
                // 负 y（2026-09-17 用户报障：总览滚动/捏合后图片盖住 TopBar）。RV 无背景，
                // clipToOutline 的 outline 必须显式给 rect，否则 BACKGROUND provider 拿到
                // null outline、裁剪不生效。
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: Outline) {
                        outline.setRect(0, 0, view.width, view.height)
                    }
                }
                // 换档时旧 child 尽量走 mCachedViews 同位置复用（不重走 bind → 不闪图）；
                // 非 bind 复用路径的封面高度由 FolderAdapter.onViewAttachedToWindow 归一兜底。
                setItemViewCacheSize(48)
                itemAnimator = null
                isVerticalScrollBarEnabled = false
                rvHolder.rv = this
                // 同时挂两条分发路径，覆盖「第一指落在 item 上」与「落在网格间隙上」两种情况
                val pinch = PinchGridSpanListener(
                    context = ctx,
                    onPinchStart = { _, _ ->
                        rvHolder.rv?.let { rv ->
                            pinchFlip.begin(rv, currentGapPx.value)
                            // 列表末端缩小（列数变多）时目标行上移，上方目标区域属于已回收
                            // 的更早 item——预览只动已挂载子项，不补铺的话顶部会留一段空白、
                            // 松手后卡片又被钳回钉底位置（先上后下两段式）。
                            // 截止位置必须按「收拢目标列数」对齐整行：按旧列数取 span*4 会
                            // 停在目标几何某行的中间，该行左侧缺的列在后程露在视口顶
                            //（2026-09-17 用户复测：左上角 3 格空白，6→9 列时 until=30 正好
                            // 卡在目标行 27..35 的中间）。展开方向 delta=0 不需要补铺，
                            // 多铺的部分松手后自然回收。
                            val lm = rv.layoutManager as? AuroraGridLayoutManager
                            val first = (rv.layoutManager as? LinearLayoutManager)
                                ?.findFirstVisibleItemPosition() ?: RecyclerView.NO_POSITION
                            if (lm != null && first != RecyclerView.NO_POSITION) {
                                val shrinkSpan = targetCols(
                                    rv.context.pxToDp(rv.width),
                                    max(0, currentLevel.value - 1),
                                )
                                lm.prefillAboveUntilPosition =
                                    max(0, (first / shrinkSpan - 4) * shrinkSpan)
                                rv.requestLayout()
                            }
                            Log.i(
                                TAG,
                                "[Overview.pinchStart] level=${currentLevel.value} " +
                                    "beginActive=${pinchFlip.isActive} first=$first " +
                                    "span=${lm?.spanCount} prefillUntil=${lm?.prefillAboveUntilPosition}",
                            )
                        }
                    },
                    onPinchProgress = { scale, _, _ ->
                        val rv = rvHolder.rv ?: return@PinchGridSpanListener
                        if (!pinchFlip.isActive) return@PinchGridSpanListener
                        val dir = if (scale >= 1f) 1 else -1
                        val targetLevel = (currentLevel.value + dir).coerceIn(0, 2)
                        val progress = if (targetLevel == currentLevel.value) {
                            0f
                        } else {
                            PinchFlipController.progressFor(scale)
                        }
                        // 目标列数用 rv 实际宽度算，与 update 提交口径一致，避免首帧屏宽兜底值
                        // 与 pxToDp(rv.width) 的舍入差异导致预览列数与提交列数不一致。
                        val widthDp = rv.context.pxToDp(rv.width)
                        pinchFlip.update(
                            rv,
                            targetLevel,
                            targetCols(widthDp, targetLevel),
                            progress,
                        )
                    },
                    onPinchEnd = {
                        val rv = rvHolder.rv ?: return@PinchGridSpanListener
                        // 捏合结束关闭上方补铺（后续换档布局按默认行为）
                        (rv.layoutManager as? AuroraGridLayoutManager)?.prefillAboveUntilPosition =
                            RecyclerView.NO_POSITION
                        if (pinchFlip.isActive) {
                            val target = pinchFlip.currentTargetLevel
                            if (pinchFlip.shouldCommit() && target != currentLevel.value) {
                                // 收尾只跑剩下的那一段，别让手感发黏
                                val remaining = 1f - pinchFlip.currentProgress
                                flipDurationMs =
                                    (FLIP_DURATION_MS * remaining).toLong().coerceAtLeast(80L)
                                // 锚点（含末端钳制位移 δ 的 commitAnchorTop）必须在 release 前
                                // 取——release 清掉 lastTables 后 commitAnchorTop 会退回原始值
                                pendingPinchAnchor.value = PinchAnchor(
                                    pinchFlip.pinchAnchorPos,
                                    pinchFlip.commitAnchorTop,
                                )
                                Log.i(
                                    TAG,
                                    "[Overview.commit] target=$target level=${currentLevel.value} " +
                                        "p=${pinchFlip.currentProgress} " +
                                        "anchor=${pendingPinchAnchor.value?.let { "${it.pos}@${it.top}" }}",
                                )
                                pinchFlip.release()
                                onLevelChange(target)
                            } else {
                                Log.i(
                                    TAG,
                                    "[Overview.settle] target=$target level=${currentLevel.value} " +
                                        "shouldCommit=${pinchFlip.shouldCommit()} p=${pinchFlip.currentProgress}",
                                )
                                pinchFlip.settle(rv)
                            }
                        }
                    },
                )
                setOnTouchListener(pinch)
                addOnItemTouchListener(pinch)
                // 模拟器/Debug 注入钩子（2026-09-17 补）：此前只有 FileGrid 挂了它，
                // 总览页 PINCH 广播是空操作，捏合问题只能真机验证
                pinch.debugAttachRv(this)
                // 首次布局完成补写量宽 state，强制 update 重跑（update 可能在布局前跑、
                // width=0 提前返回；教训见 FileGrid factory 的同款注释）
                doOnLayout { view ->
                    if (measuredWidthDp == 0 && view.width > 0) {
                        measuredWidthDp = view.context.pxToDp(view.width)
                    }
                }
                // 宽度变化自愈（对齐 FileGrid factory 的同款监听）：侧栏开合（3.5）逐帧改
                // 变内容宽度但不触发 Compose 重组。封面已固定 WRAP_CONTENT（按宽自动正方
                // 形，无滞后无 notify），这里只负责**列数收敛**：宽度稳定 80ms 后写量宽
                // state → 重组 → update 内 targetCols + animateSpanChange 以 FLIP 动画把
                // 列数确定性收敛，避免列数停在旧值等某次随机重组才跳变（卡片突然变大、
                // 与开合脱节）。
                var pendingSpanSync: Runnable? = null
                addOnLayoutChangeListener { v, left, _, right, _, oldLeft, _, oldRight, _ ->
                    val newW = right - left
                    if (newW <= 0 || newW == oldRight - oldLeft) return@addOnLayoutChangeListener
                    pendingSpanSync?.let(v::removeCallbacks)
                    val spanSync = Runnable {
                        // 宽度已稳定：退场预测（sidebarSynced 对齐目标状态），下一轮重组按
                        // 实际宽度复算列数/cell（与点按时的预测值通常一致，仅小数舍入差）
                        sidebarSynced.value = currentSidebarVisible.value
                        spanSyncTick.value++
                    }
                    pendingSpanSync = spanSync
                    v.postDelayed(spanSync, 80)
                }
                // 滚动位置上报：宿主用普通字段记录（非 Compose state，不触发重组），
                // 返回总览时作为 initialScrollTop 传回归位
                addOnScrollListener(object : RecyclerView.OnScrollListener() {
                    override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                        onScrollChanged(rv.computeVerticalScrollOffset())
                    }
                })
            }.also { rv ->
                // 4.4 下拉刷新：注册在捏合监听器之后（同 FileGrid 的注释）
                pullToRefreshState?.let { st ->
                    val currentPull = currentOnPullToRefresh
                    rv.addOnItemTouchListener(
                        PullToRefreshListener(
                            state = st,
                            thresholdPx = ctx.dp(80),
                            maxPullPx = ctx.dp(160),
                            onRefresh = { currentPull.value?.invoke { finishPullToRefresh(rv, st) } },
                        )
                    )
                }
            }
        },
        update = { rv ->
            val lm = rv.layoutManager as? GridLayoutManager ?: return@AndroidView
            if (rv.width <= 0) return@AndroidView
            spanSyncTick.value // 订阅：侧栏动画结束后由监听器递增，触发本次收敛重算
            val predicting = sidebarVisible != sidebarSynced.value
            val sidebarPx = with(density) { SIDEBAR_WIDTH_DP.roundToPx() }
            // 预测中 = 动画进行中：宽度取目标状态的最终值（点按瞬间的 rv.width + 全部增量）
            val widthPx = rv.width + if (predicting) (if (sidebarVisible) -sidebarPx else sidebarPx) else 0
            val widthDp = rv.context.pxToDp(widthPx)
            if (measuredWidthDp != widthDp) measuredWidthDp = widthDp
            val span = targetCols(widthDp, level)
            if (span != lm.spanCount) {
                // 捏合落档的锚点只消费一次；非捏合换档（anchor=null）退回 firstVisible 锚点
                val anchor = pendingPinchAnchor.value
                pendingPinchAnchor.value = null
                animateSpanChange(rv, lm, decoration, span, flipDurationMs, pinchAnchor = anchor)
                flipDurationMs = FLIP_DURATION_MS
            }
            // 封面高度同步（L8 同款，对齐 FileGrid.applyCellWidth）。cellWidthPx 现仅作
            // 捏合预览的几何簿记（封面已 WRAP_CONTENT 自动正方形），用预测宽度保持一致。
            val gap = currentGapPx.value
            val cell = ((widthPx - rv.paddingLeft - rv.paddingRight - (span - 1) * gap) / span)
                .coerceAtLeast(1)
            gridAdapter.applyCellWidth(cell)
        },
        modifier = modifier.clipToBounds(),
    )
}

private class FolderAdapter(
    private val loader: ThumbnailLoader,
    private val surfaceColor: Int,
    private val textPrimaryColor: Int,
    private val textSecondaryColor: Int,
    private val onClick: (Folder) -> Unit,
    private val onLongClick: (Folder) -> Unit,
) : RecyclerView.Adapter<FolderAdapter.VH>() {

    private val folders = mutableListOf<Folder>()
    private var selectedIds: Set<String> = emptySet()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** 进度驱动 FLIP 控制器；捏合中新绑定的 item 需要补上当前进度的 transform。 */
    var pinchFlip: PinchFlipController? = null

    /** 当前单元格宽度（px）。0 = 尚未量出（封面交回 SquareImageView 的 WRAP_CONTENT 正方形）。 */
    private var cellWidthPx: Int = 0

    companion object {
        /** 局部刷新 payload：只更新封面高度，不重新 bind（不重载图片、不动 FLIP transform）。 */
        private const val PAYLOAD_CELL = "cell"
    }

    fun submit(list: List<Folder>) {
        // 幂等守卫（对齐 FileGrid.submit）：热刷新/回前台兜底会带着相同数据重走一遍
        // LaunchedEffect(folders)，无变化时不必 notifyDataSetChanged 把列表打回顶部
        if (folders == list) return
        folders.clear()
        folders.addAll(list)
        notifyDataSetChanged()
    }

    /**
     * 差量刷新选中态（4.1，对齐 FileGridAdapter.updateSelection）：只 notify 选中
     * 变化的 item，避免全量刷新打断 FLIP/图片加载。
     */
    fun updateSelection(selection: Set<String>) {
        val old = selectedIds
        selectedIds = selection
        val changed = mutableListOf<Int>()
        for (i in folders.indices) {
            if ((folders[i].id in old) != (folders[i].id in selection)) changed.add(i)
        }
        changed.forEach { notifyItemChanged(it) }
    }

    /**
     * 更新单元格宽度，**只改可见 item 的封面高度，绝不 notifyDataSetChanged**（L8 同款，
     * 对齐 FileGridAdapter.applyCellWidth）。换档（列宽变化）后旧 item 是复用不重新 bind 的，
     * 直接改 layoutParams + requestLayout 会因「update 落在 layout 阶段」被 RV 吞掉——
     * 封面停在上一档高度（长条/错位，2026-09-17 用户报障），滚走再滚回才恢复。
     * FolderAdapter 此前完全没有这套机制，而捏合预览（PinchFlipController.applyChildReal）
     * 会把显式高度写进封面 lp，残留高度在复用中扩散——这就是总览捏合后布局错乱的根源。
     */
    fun applyCellWidth(cellPx: Int) {
        if (cellPx <= 0) return
        if (cellWidthPx == cellPx) return
        val wasZero = cellWidthPx <= 0
        cellWidthPx = cellPx
        if (wasZero) {
            // 从「未量出宽度」变为有宽度：已有 item 的封面高度还是默认的，全量刷新一次
            notifyDataSetChanged()
            return
        }
        notifyItemRangeChanged(0, folders.size, PAYLOAD_CELL)
    }

    fun cancel() = scope.cancel()

    override fun getItemCount(): Int = folders.size

    class VH(
        view: View,
        val cover: ImageView,
        val count: TextView,
        val name: TextView,
        val border: View,
        val check: TextView,
    ) : RecyclerView.ViewHolder(view) {
        var job: Job? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val context = parent.context
        val radius = context.dp(8).toFloat()

        val cover = SquareImageView(context).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(surfaceColor)
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
                }
            }
        }

        // 选中态：blue-400 描边 + 蓝圆白勾角标（对齐桌面 FoldersOverview isSelected 分支）
        val border = buildSelectBorder(context, radiusDp = 8)
        val check = buildCheckBadge(context)

        val count = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 9f)
            setTextColor(android.graphics.Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(0x80000000.toInt())
                cornerRadius = context.dp(50).toFloat()
            }
            setPadding(context.dp(6), context.dp(2), context.dp(6), context.dp(2))
        }

        val name = TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(textPrimaryColor)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(context.dp(4), context.dp(4), context.dp(4), 0)
        }

        val frame = CoverFrame(context).apply {
            addView(
                cover,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                border,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
            addView(
                check,
                FrameLayout.LayoutParams(
                    context.dp(24),
                    context.dp(24),
                    Gravity.TOP or Gravity.START,
                ).apply { setMargins(context.dp(8), context.dp(8), 0, 0) },
            )
            addView(
                count,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM or Gravity.END,
                ).apply { setMargins(0, 0, context.dp(6), context.dp(6)) },
            )
        }

        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(
                frame,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
            addView(
                name,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }

        val vh = VH(root, cover, count, name, border, check)
        root.setOnClickListener {
            val pos = vh.bindingAdapterPosition
            if (pos != RecyclerView.NO_POSITION) onClick(folders[pos])
        }
        // 4.1 长按（同 FileGridAdapter）：总览的编辑模式入口 / 范围选择触发器
        root.setOnLongClickListener { v ->
            val pos = vh.bindingAdapterPosition
            if (pos != RecyclerView.NO_POSITION) {
                v.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                onLongClick(folders[pos])
                true
            } else {
                false
            }
        }
        return vh
    }

    override fun onBindViewHolder(holder: VH, position: Int, payloads: MutableList<Any>) {
        if (payloads.isNotEmpty()) {
            // 局部刷新（PAYLOAD_CELL）：封面高度固定 WRAP_CONTENT（SquareImageView 按宽
            // 自动正方形，见 onBindViewHolder），不重新 bind、不清 FLIP transform、不重载图片。
            holder.cover.applyCoverHeight(ViewGroup.LayoutParams.WRAP_CONTENT)
            holder.name.setCellWidth(cellWidthPx)
            // 选中态一并刷（applyCellWidth 的 payload 与 updateSelection 的变更可能落在
            // 同一批布局里，payload 分支不回 bind，漏刷会留下过期边框/勾/名字胶囊）
            val f = folders.getOrNull(position)
            val selected = f != null && f.id in selectedIds
            holder.border.visibility = if (selected) View.VISIBLE else View.GONE
            holder.check.visibility = if (selected) View.VISIBLE else View.GONE
            holder.name.applySelectedName(selected, textPrimaryColor, cellWidthPx)
            forceMeasureOnRebind(holder)
            return
        }
        onBindViewHolder(holder, position)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        // 同 FileGrid：清掉 FLIP 动画残留的 transform
        resetFlipTransform(holder.itemView)
        // 捏合进行中新绑定的 item 要补上当前进度的 transform，否则会以未变换的样子闪现
        pinchFlip?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)

        val folder = folders[position]
        holder.name.text = folder.name
        holder.count.text = folder.imageCount.toString()
        holder.count.visibility = if (folder.imageCount > 0) View.VISIBLE else View.GONE

        // 选中态（4.1）：blue-400 描边 + 蓝圆白勾
        val selected = folder.id in selectedIds
        holder.border.visibility = if (selected) View.VISIBLE else View.GONE
        holder.check.visibility = if (selected) View.VISIBLE else View.GONE

        // 封面高度固定 WRAP_CONTENT：SquareImageView 在 onMeasure 里按宽定高，高度与宽度
        // 同一轮测量对齐——侧栏开合逐帧推挤宽度时封面全程正方形、零滞后零 notify
        //（2026-09-20 抖动修复；显式 cellWidthPx 高度依赖 notify→重绑跟进，滞后一帧微抖）。
        holder.cover.applyCoverHeight(ViewGroup.LayoutParams.WRAP_CONTENT)
        holder.name.setCellWidth(cellWidthPx)
        // 名字胶囊在 setCellWidth 之后：选中态要把宽度从固定列宽切成 WRAP（胶囊只包住
        // 文字、水平居中），先切会被 setCellWidth 覆盖回固定宽（退化成整行蓝条）
        holder.name.applySelectedName(selected, textPrimaryColor, cellWidthPx)

        val uri = folder.coverUri
        if (uri != null) {
            val imageId = loader.extractImageId(uri)
            val cached = loader.peekMemory(imageId)
            if (cached != null) {
                holder.cover.setImageBitmap(cached)
            } else {
                holder.cover.setImageBitmap(null)
                holder.job?.cancel()
                holder.job = scope.launch {
                    val bmp = loader.loadFastLimited(imageId)
                    if (holder.bindingAdapterPosition == position) {
                        holder.cover.setImageBitmap(bmp)
                    }
                }
            }
        } else {
            holder.cover.setImageBitmap(null)
        }
        forceMeasureOnRebind(holder)
    }

    /**
     * 重绑/局部刷新后强制重测（对齐 FileGridAdapter.forceMeasureOnRebind）。封面高度在
     * bind 时只写字段——[SquareImageView] 把内容级 requestLayout 降级为重绘后，没人再
     * 设置强制测量标志；RV fill 复用 view 时若尺寸 spec 与上次相同，`View.measure` 会跳过
     * onMeasure，bind 写入的新高度不被消费、渲染沿用上一档位的过期实测高度（长条的
     * 另一来源）。forceLayout 只置强制标志、不上抛，不会引发整网格重布局风暴。
     */
    private fun forceMeasureOnRebind(holder: VH) {
        holder.itemView.forceLayout()
        holder.cover.forceLayout()
        (holder.cover.parent as? View)?.forceLayout()
    }

    override fun onViewRecycled(holder: VH) {
        holder.job?.cancel()
        holder.cover.setImageBitmap(null)
        // 回收时置强制测量标志：经 mCachedViews 复用（不重走 bind）的 view 也必须重测，
        // 否则可能带着过期高度混进新一轮布局（同 FileGrid.onViewRecycled）
        holder.itemView.forceLayout()
        holder.cover.forceLayout()
    }

    override fun onViewAttachedToWindow(holder: VH) {
        // 经 mCachedViews 复用的 view（换档后同位置复用等）**不走 onBindViewHolder**，
        // 封面 lp 高度可能带着捏合预览写入的插值值。attach 发生在 fill 测量该 child 之前，
        // 这里归一回 WRAP_CONTENT（按宽自动正方形），兜住所有不经 bind 的复用路径
        //（同 FileGrid.onViewAttachedToWindow）。
        holder.cover.applyCoverHeight(ViewGroup.LayoutParams.WRAP_CONTENT)
        // 选中态归一（2026-09-20 用户复现「部分选中文件夹无高亮」）：同位置缓存复用
        // 不走 bind，边框/勾/名字胶囊可能停留在选中变化前的状态，按当前 selectedIds 归一
        val folder = folders.getOrNull(holder.bindingAdapterPosition)
        if (folder != null) {
            val selected = folder.id in selectedIds
            holder.border.visibility = if (selected) View.VISIBLE else View.GONE
            holder.check.visibility = if (selected) View.VISIBLE else View.GONE
            holder.name.applySelectedName(selected, textPrimaryColor, cellWidthPx)
        }
        holder.itemView.forceLayout()
    }
}
