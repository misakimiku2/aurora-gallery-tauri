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
import androidx.compose.foundation.layout.fillMaxSize
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
 * 总览 RV 的跨组合存活状态（2026-09-28：修复「从文件夹返回主界面会看到主界面刷新一下」）。
 *
 * 背景：主界面（[FoldersOverview]）与文件夹内网格在宿主里是互斥的 `when` 分支，进入文件夹时
 * 总览整块**离开组合** → `AndroidView` 被 dispose、原生 RecyclerView 销毁；返回时重新走
 * factory，得到全新的 RV + 全新的 adapter（内部数据为空）→ `notifyDataSetChanged` 全量重绑、
 * 缩略图重新走一遍加载流程（即使命中内存缓存也要重新 setImageBitmap 并重新 measure/layout），
 * 肉眼就是「主界面刷了一下」。首启尤其明显：此时缩略图缓存还没填满，重绑后有若干张是
 * 先空后填的异步加载。
 *
 * 修法：把 RV 实例连同 adapter / FLIP 控制器 / 间距 decoration / 已量出的宽度提到本类，由
 * **宿主**（App 层 `remember`）持有、跨组合存活；返回总览时 factory 直接把同一个 RV 摘回来
 * 重新 attach——VH 池、滚动位置、已绑定的封面全部原样保留，零重绑零重载、也不必再恢复滚动。
 *
 * 生命周期：宿主组合销毁（Activity 结束 / 配置变更）时由宿主调用 [close]。
 */
class FoldersOverviewState {
    internal val rvHolder = RvHolder()
    internal val pinchFlip = PinchFlipController()
    internal val pendingPinchAnchor = AnchorOverrideHolder()
    private var adapter: FolderAdapter? = null
    private var decoration: GridSpacingDecoration? = null

    /**
     * 已量出的容器宽度（dp）：跨组合保留，返回总览时首帧就按正确宽度算列数，
     * 不再出现「先按兜底列数布局、重组后再 FLIP 收敛」的重排。
     */
    internal var measuredWidthDp by mutableIntStateOf(0)

    /** 本次组合是否为「复用旧 RV」：true = 滚动位置/宽度/数据都还在，无需恢复与重排。 */
    val reused: Boolean get() = rvHolder.rv != null

    internal fun obtainAdapter(
        loader: ThumbnailLoader,
        surfaceColor: Int,
        textPrimaryColor: Int,
        textSecondaryColor: Int,
        onClick: (Folder) -> Unit,
        onLongClick: (Folder) -> Unit,
    ): FolderAdapter {
        adapter?.let { return it }
        return FolderAdapter(
            loader = loader,
            surfaceColor = surfaceColor,
            textPrimaryColor = textPrimaryColor,
            textSecondaryColor = textSecondaryColor,
            onClick = onClick,
            onLongClick = onLongClick,
        ).also {
            it.pinchFlip = pinchFlip
            adapter = it
        }
    }

    internal fun obtainDecoration(gapPx: Int): GridSpacingDecoration {
        decoration?.let {
            it.gapPx = gapPx
            return it
        }
        return GridSpacingDecoration(6, gapPx).also { decoration = it }
    }

    /** 宿主组合销毁时调用：取消 adapter 的图片加载协程并丢弃 RV 引用。 */
    internal fun close() {
        adapter?.cancel()
        adapter = null
        decoration = null
        rvHolder.rv = null
        measuredWidthDp = 0
    }
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
     * 本组件因导航离开组合再回来时会重新走 factory，由宿主把离开前记录的位置传回；
     * 只在本次组合实例消费一次，之后的重扫/重组不再重复归位。
     * 注：[rvState] 复用旧 RV 时（滚动位置本身就还在）该值会被忽略。
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
    /**
     * 跨组合保留的 RV 状态（2026-09-28 修复「返回主界面刷一下」）。
     * 由宿主（App 层 `remember`）持有并在此传入，本组件在返回总览时复用同一个
     * RecyclerView / adapter，不再重建重绑。不传则退化为「每个组合实例各自一份」
     * （历史行为，仅作兜底；宿主应传并在自身销毁时 [FoldersOverviewState.close]）。
     */
    rvState: FoldersOverviewState = remember { FoldersOverviewState() },
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current
    val currentSelectedIds = rememberUpdatedState(selectedIds)

    // 进度驱动 FLIP（与 FileGrid 同一套手感：捏合 = FLIP 动画的进度条）。
    // 必须定义在 gridAdapter 之前——gridAdapter 与下面的 AndroidView 都要用。
    // 全部来自 rvState（跨组合存活）：进文件夹再返回时拿到的是同一批实例，
    // 不再走「新 RV + 空 adapter → 全量重绑 → 缩略图重新加载」那条可见刷新路径。
    val rvHolder = rvState.rvHolder
    val pinchFlip = rvState.pinchFlip
    // 捏合换档的锚点透传：onPinchEnd 记录 → update 消费（一次）。落档必须保持同一锚点
    // 停在同一屏幕位置（含末端钳制位移 δ 后的 commitAnchorTop），预览与收尾 FLIP 才
    // 无缝衔接——此前没透传，animateSpanChange 退回 firstVisible 锚点，与 FileGrid 不一致。
    val pendingPinchAnchor = rvState.pendingPinchAnchor
    // 收尾动画时长：捏合换档时按剩余进度缩短，用后即复位
    var flipDurationMs by remember { mutableLongStateOf(FLIP_DURATION_MS) }

    // 长按回调转发最新引用（同 FileGrid：adapter 的 remember 只捕获首帧 lambda）
    val currentOnFolderLongClick = rememberUpdatedState(onFolderLongClick)
    // 点击同理：adapter 跨组合存活后，onCreateViewHolder 里捕获的是首帧 lambda，
    // 必须走最新引用，否则返回总览后点卡片会用到过期闭包
    val currentOnFolderClick = rememberUpdatedState(onFolderClick)
    // 4.4 下拉刷新动作同理（factory 闭包只创建一次）
    val currentOnPullToRefresh = rememberUpdatedState(onPullToRefresh)

    val gridAdapter = remember(rvState) {
        rvState.obtainAdapter(
            loader = thumbnailLoader,
            surfaceColor = colors.surface.toArgb(),
            textPrimaryColor = colors.textPrimary.toArgb(),
            textSecondaryColor = colors.textSecondary.toArgb(),
            onClick = { currentOnFolderClick.value(it) },
            onLongClick = { currentOnFolderLongClick.value(it) },
        )
    }

    // 页面级拖拽滚动条（2026-10-08）：与网格同层叠放，滚动时出现、静止后淡出。
    // controller 每个组合实例一份，只管自己 add 的那一个滚动监听——RV 跨组合复用时
    // 「旧组合 detach」与「新组合 attach」无论谁先谁后都不会互相摘错监听器。
    val scrollbar = remember { GridScrollbarController() }
    DisposableEffect(scrollbar) { onDispose { scrollbar.detach() } }

    LaunchedEffect(folders) {
        // 复用旧 RV 时 adapter 里的数据还在，内容相同则 submit 是 no-op：
        // 不 notify 就不要把宿主记录的滚动位置归零（否则离开时记的位置被抹掉）
        if (gridAdapter.submit(folders)) {
            // notifyDataSetChanged 会把 RV 打回顶部（重扫/数据替换场景），记忆同步归零；
            // 返回总览的恢复（pendingRestore>0）在其后的布局回调里执行，会覆盖这里的值
            onScrollChanged(0)
        }
        // 数据变化后刷新一次滚动条几何（同 FileGrid：不等第一次滚动才更新可显示性）
        rvHolder.rv?.doOnLayout { scrollbar.sync() }
    }

    LaunchedEffect(selectedIds) {
        gridAdapter.updateSelection(currentSelectedIds.value)
    }

    // 滚动位置恢复：本次组合实例消费一次。submit 之后注册 doOnLayout——首个带数据的
    // 布局完成后 scrollBy 归位（LinearLayoutManager 按需填充，一步可滚到位），避免
    // 对着空内容滚；消费完置 0，重扫/重组不会重复归位。
    // 复用旧 RV 时滚动位置本身就还在（detach 不清滚动），再滚一次反而二次偏移，故置 0。
    var pendingRestore by remember { mutableIntStateOf(if (rvState.reused) 0 else initialScrollTop) }
    LaunchedEffect(Unit) {
        if (pendingRestore > 0) {
            val target = pendingRestore
            rvHolder.rv?.doOnLayout { rv ->
                pendingRestore = 0
                rv.scrollBy(0, target)
            }
        }
    }

    // 注：adapter 的协程取消交给宿主的 rvState.close()（见类注释）——这里若在组合
    // dispose 时 cancel，复用场景会把 adapter 的加载协程一次性掐掉、之后再也拉不动图。

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

    // 宽度分档（M8b 1.1 收敛自内联 screenWidthDp >= 600）：分档值逐字不变，仅判据收敛
    val isTablet = !com.aurora.gallery.kotlin.ui.isCompactWidth(LocalConfiguration.current)
    val gapPx = context.dp(if (isTablet) 16 else 10)
    val paddingPx = context.dp(if (isTablet) 24 else 8)

    // 3.5 预测收敛（同 FileGrid）：侧栏开合动画是纯 layout 变化、不触发重组，列数若等
    // 动画结束才收敛会与面板脱节（卡片突变）。动画进行中（sidebarVisible 与已同步状态
    // 不一致）按目标状态的最终宽度预测列数，点按瞬间一次收敛、与面板动画同步。
    val density = LocalDensity.current
    val currentSidebarVisible = rememberUpdatedState(sidebarVisible)
    val sidebarSynced = remember { mutableStateOf(sidebarVisible) }
    val spanSyncTick = remember { mutableIntStateOf(0) }

    // 主题换色（M4c）：AuroraTheme.colors 变化时把三色推入 adapter 并全量重绑。
    // adapter 的 remember 无 key，构造色只对首帧有效；applyThemeColors 无变化时 no-op。
    LaunchedEffect(colors) {
        gridAdapter.applyThemeColors(
            colors.surface.toArgb(),
            colors.textPrimary.toArgb(),
            colors.textSecondary.toArgb(),
        )
    }

    // 三档捏合：档位是应用级状态（AppState.gridLevel），这里只读参数 + 写回回调
    val currentLevel = rememberUpdatedState(level)
    // factory 闭包只创建一次，gapPx 直接捕获会在旋转（平板/手机间距变化）后读到旧值。
    val currentGapPx = rememberUpdatedState(gapPx)
    // decoration 同样来自 rvState：复用 RV 时不能重复 addItemDecoration（会叠加间距）
    val decoration = remember(rvState) { rvState.obtainDecoration(gapPx) }

    // 容器宽度（dp）：doOnLayout 首次布局后写入，强制 update 重跑（对齐 FileGrid 的
    // 3.2fix——update 在 RV 布局完成前 width=0 提前返回后，必须有下一次重跑的触发源，
    // 否则 applyCellWidth 永远量不出单元格宽度）。
    // 存在 rvState 里跨组合保留：返回总览时首帧就是已量出的真实宽度，不再出现
    // 「先按兜底列数布局、重组后 FLIP 收敛」的重排。
    // 组合期建立订阅（2026-09-20 修复）：update 是 AndroidView 的非观察 lambda，其中的
    // state 读取不订阅快照；不在这里读一次，doOnLayout 的首次量宽写入不会触发重组，
    // update 就再也没有重跑时机——冷启动列数停在 factory 的屏宽兜底值（实测 6 列/299px
    // 卡片，正确为 5 列/365px），直到任意一次无关的状态变化才「顺带」收敛。FileGrid 在
    // 组合期读 containerWidthDp 所以无此问题。
    @Suppress("UNUSED_VARIABLE") val measuredWidthDpSubscribed = rvState.measuredWidthDp

    // 滚动条叠在网格上层（Box）：只有按在拇指上才吃事件，其余全部放行给 RV。
    Box(modifier = modifier.clipToBounds()) {
        AndroidView(
            factory = { ctx ->
                // 复用旧 RV（2026-09-28：修「返回主界面刷一下」）：进文件夹时总览离开组合，
                // AndroidView dispose 只是把 RV 从窗口中摘下、实例本身还在 rvState 里。这里
                // 直接把它从上一个宿主 ViewGroup 摘下来重新 attach——VH 池、滚动位置、已绑定
                // 的封面全部原样保留，不必重新 create/bind、不必重新加载缩略图。
                // 必须先 removeView：旧 AndroidViewHolder 仍是它的 parent，不摘就 addView 会崩。
                rvHolder.rv?.let { existing ->
                    (existing.parent as? ViewGroup)?.removeView(existing)
                    // 复用分支也要重新挂滚动条：本组合的 controller 是新的
                    scrollbar.attach(RvScrollMetrics(existing))
                    return@AndroidView existing
                }
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
                  // 首次布局完成补写量宽 state，强制 update 重跑（update 可能在布局前跑、
                  // width=0 提前返回；教训见 FileGrid factory 的同款注释）
                  doOnLayout { view ->
                      if (rvState.measuredWidthDp == 0 && view.width > 0) {
                          rvState.measuredWidthDp = view.context.pxToDp(view.width)
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
                  // 挂页面滚动条：attach 只登记一个 OnScrollListener，不碰 RV 既有配置
                  // （下拉刷新/捏合监听都在上面注册完毕，互不干扰）
                  scrollbar.attach(RvScrollMetrics(rv))
                  // 4.4 下拉刷新：注册在捏合监听器之后（同 FileGrid 的注释）
                  pullToRefreshState?.let { st ->
                      val currentPull = currentOnPullToRefresh
                      rv.addOnItemTouchListener(
                          PullToRefreshListener(
                              state = st,
                              thresholdPx = ctx.dp(80),
                              maxPullPx = ctx.dp(160),
                              onRefresh = { currentPull.value?.invoke { finishPullToRefresh(rv, st, ctx.dp(80)) } },
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
              if (rvState.measuredWidthDp != widthDp) rvState.measuredWidthDp = widthDp
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
            // fillMaxSize 而非 matchParentSize：让网格自己把 Box 撑满，不依赖「Box 先量出
          // 尺寸再回灌子节点」这条隐式链（命中层的定位也按同一套坐标算）
          modifier = Modifier.fillMaxSize(),
        )
        GridScrollbar(
            controller = scrollbar,
            color = colors.textSecondary,
            indicatorColor = colors.content,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

internal class FolderAdapter(
    private val loader: ThumbnailLoader,
    // 主题三色用 var（M4c）：适配器被 remember 持有，构造色只对首帧有效，主题切换
    // 经 applyThemeColors 推入并重绑（同 FileGridAdapter）。
    private var surfaceColor: Int,
    private var textPrimaryColor: Int,
    private var textSecondaryColor: Int,
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

    /**
     * @return 是否真的发了 notifyDataSetChanged（false = 内容未变，列表位置不受影响）。
     * 返回值给调用方决定要不要把「宿主记忆的滚动位置」同步归零——复用 RV 的场景下
     * 数据常常完全没变，此时归零会误伤下一次返回时的恢复。
     */
    fun submit(list: List<Folder>): Boolean {
        // 幂等守卫（对齐 FileGrid.submit）：热刷新/回前台兜底会带着相同数据重走一遍
        // LaunchedEffect(folders)，无变化时不必 notifyDataSetChanged 把列表打回顶部
        if (folders == list) return false
        folders.clear()
        folders.addAll(list)
        notifyDataSetChanged()
        return true
    }

    /**
     * 主题换色（M4c）：更新三色并全量重绑。无变化时 no-op（挂载后的首次
     * LaunchedEffect 不触发无谓重绑）。attached 视图的重刷落点：名字色在
     * applySelectedName（bind 路径已重刷）、封面占位底在 onBindViewHolder 补刷。
     */
    fun applyThemeColors(surface: Int, textPrimary: Int, textSecondary: Int): Boolean {
        if (surfaceColor == surface && textPrimaryColor == textPrimary && textSecondaryColor == textSecondary) {
            return false
        }
        surfaceColor = surface
        textPrimaryColor = textPrimary
        textSecondaryColor = textSecondary
        notifyDataSetChanged()
        return true
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
        val check: View,
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
        // 主题换色（M4c）：封面占位底在 onCreateViewHolder 上色后随池复用，bind 重刷
        holder.cover.setBackgroundColor(surfaceColor)
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
            // M6a 阶段 4：LAN 总览卡片的 coverUri 装的是缩略图 URL（数据层映射时填入），
            // 走 ThumbnailLoader 的 URL 分支；与本地分支同一内存池、同一并发信号量。
            if (uri.startsWith("http")) {
                val cached = loader.peekMemoryUrl(uri)
                if (cached != null) {
                    holder.cover.setImageBitmap(cached)
                } else {
                    holder.cover.setImageBitmap(null)
                    holder.job?.cancel()
                    holder.job = scope.launch {
                        val bmp = loader.loadFastUrlLimited(uri)
                        if (holder.bindingAdapterPosition == position) {
                            holder.cover.setImageBitmap(bmp)
                        }
                    }
                }
            } else {
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
