package com.aurora.gallery.kotlin.ui.components

import android.graphics.Outline
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.util.Log
import android.util.TypedValue
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.core.view.doOnLayout
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.StaggeredGridLayoutManager
import androidx.recyclerview.widget.StaggeredSpanAccess
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import com.aurora.gallery.kotlin.viewer.PhotoRectQuery
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.aurora_core.Image
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 图片网格（原生 RecyclerView，对齐系统相册滚动性能）。
 *
 * 支持 [LayoutMode] 三种排布（安卓端不含 list，见 LayoutMode 的 KDoc）与 [GroupBy] 分组标题。
 * 三种模式的三档捏合都是**进度驱动（跟手）预览**：GRID 行号公式、MASONRY 列分配模拟、
 * ADAPTIVE 行装箱模拟（见 AdaptiveGrid.kt），松手按剩余进度收尾 FLIP 落档。
 */
@Composable
fun FileGrid(
    images: List<Image>,
    selectedIds: Set<String>,
    thumbnailLoader: ThumbnailLoader,
    /**
     * 点击一张图。第二个参数是那张卡片的**封面视图**（[PhotoRefs.cover]）——查看器进出过渡
     * 要拿它的屏幕矩形和上面已经解码好的缩略图当动画源（2026-10-08，见 ViewerTransition）。
     */
    onItemClick: (Image, ImageView) -> Unit,
    /**
     * 长按回调（4.1 编辑模式入口）。语义在宿主侧决定：非编辑模式 → 进选择模式；
     * 编辑模式内长按未选中项 → 范围选择；已选中项 → 预留 M2 上下文菜单（当前无操作）。
     */
    onItemLongClick: (Image) -> Unit = {},
    modifier: Modifier = Modifier,
    layoutMode: LayoutMode = LayoutMode.GRID,
    groupBy: GroupBy = GroupBy.NONE,
    /**
     * 三档捏合档位：0=小、1=中、2=大（默认中档）。
     * 由应用级状态传入（3.1 `AppState.gridLevel`，L2 修复）：进文件夹/返回总览不再重置，
     * 写回经 [onLevelChange]，本组件不持有档位。
     */
    level: Int = 1,
    onLevelChange: (Int) -> Unit = {},
    /** 3.5 侧栏目标状态：用于开合动画期间的列数预测（见 update 内的 predicting 注释）。 */
    sidebarVisible: Boolean = false,
    /** 4.4 下拉刷新状态（宿主创建并渲染指示器）；null = 不启用。 */
    pullToRefreshState: PullToRefreshState? = null,
    /** 4.4 刷新动作：宿主触发扫描，完成时回调 [onComplete]（指示器落勾）。 */
    onPullToRefresh: ((onComplete: () -> Unit) -> Unit)? = null,
    /**
     * 专题详情整页滚动（3.3fix③ overlay 化）：顶部额外留白 px（= 头部自然高度），
     * 让首行初始落在头部下缘、收起时内容从头部底下钻出。只影响 RV 顶 padding。
     */
    topInsetPx: Int = 0,
    /** 整页滚动联动：RV 实际滚动增量（OnScrollListener 的 dy）原样回传宿主。 */
    onScrolled: ((Int) -> Unit)? = null,
    /**
     * 查看器退出动画的落点通道（2026-10-08，见
     * [com.aurora.gallery.kotlin.viewer.PhotoRectQuery]）：本网格把「按图片 id 取可见卡片封面
     * 矩形」注册进来、离开组合时摘掉。null = 不提供（退出动画退回淡出兜底）。
     */
    photoRectQuery: PhotoRectQuery? = null,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current

    // 折叠状态（按分组 id 记录）；切换分组方式时重置
    var collapsedIds by remember(groupBy) { mutableStateOf<Set<String>>(emptySet()) }
    val currentCollapsed = rememberUpdatedState(collapsedIds)

    // 宽度分档（M8b 1.1 收敛自内联 screenWidthDp >= 600）：宽 ≥600dp（含横屏手机）拿平板档
    // 间距——分档值逐字不变，仅判据收敛
    val isTablet = !com.aurora.gallery.kotlin.ui.isCompactWidth(LocalConfiguration.current)
    val gapDp = if (isTablet) 16 else 10
    val paddingDp = if (isTablet) 24 else 8
    val gapPx = context.dp(gapDp)
    val paddingPx = context.dp(paddingDp)

    // 三档捏合：档位是应用级状态（AppState.gridLevel），这里只读参数 + 写回回调
    val currentLevel = rememberUpdatedState(level)
    // factory 闭包只创建一次，直接捕获 layoutMode/groupBy/gapPx 会在切换模式/分组后读到旧值，
    // 导致捏合判定与目标列数算错（布局错乱）。用 rememberUpdatedState 让闭包始终读到最新值。
    val currentLayoutMode = rememberUpdatedState(layoutMode)
    val currentGroupBy = rememberUpdatedState(groupBy)
    val currentGapPx = rememberUpdatedState(gapPx)
    // 3.5 预测收敛：侧栏开合动画是纯 layout 变化（不触发重组），若列数等动画结束后才
    // 收敛，会与面板开合脱节（用户感知「两步走」/随机时机卡片突变）。记住「量宽已同步到
    // 哪个侧栏状态」，未同步（=动画进行中）时 update 按目标状态的**最终宽度**预测列数，
    // 列数在点按瞬间一次收敛、与面板动画同步（对齐 React 的同步过渡）；动画结束由网格
    // 的宽度监听器翻转 [sidebarSynced] 退场。
    val currentSidebarVisible = rememberUpdatedState(sidebarVisible)
    val sidebarSynced = remember { mutableStateOf(sidebarVisible) }
    val spanSyncTick = remember { mutableIntStateOf(0) }
    // 整页滚动联动（3.3fix③）：factory 闭包只建一次，回调经 rememberUpdatedState 转发最新引用
    val currentOnScrolled = rememberUpdatedState(onScrolled)
    val gridScrollForwarder = remember {
        object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                currentOnScrolled.value?.invoke(dy)
            }
        }
    }
    val decoration = remember { GridSpacingDecoration(6, gapPx) }

    // 进度驱动 FLIP：捏合手势 = FLIP 动画的进度条（见 PinchFlipController）
    val rvHolder = remember { RvHolder() }
    val pinchFlip = remember { PinchFlipController() }
    // 页面级拖拽滚动条（2026-10-08）：与网格同层叠放，滚动时出现、静止后淡出。
    // 每个组合实例一份 controller，只管自己 add 的那一个滚动监听（详见其 KDoc）。
    val scrollbar = remember { GridScrollbarController() }
    DisposableEffect(scrollbar) { onDispose { scrollbar.detach() } }
    // 收尾动画时长：捏合换档时按**剩余进度**缩短（捏到 80% 松手只剩 20% 要跑），用后即复位
    var flipDurationMs by remember { mutableLongStateOf(FLIP_DURATION_MS) }

    // 容器宽度（dp）：先用配置屏宽兜底，再由 AndroidView.update 用量出的实际值覆盖。
    // 兜底是必须的——adaptive 的行化依赖宽度，首帧若为 0 会退化成「每张图独占一行」闪一下。
    var measuredWidthDp by remember { mutableIntStateOf(0) }
    val containerWidthDp = measuredWidthDp.takeIf { it > 0 } ?: LocalConfiguration.current.screenWidthDp
    // sticky 分组标题实例；RecyclerView 无法查询已挂载的 ItemDecoration，只能自己记账
    var stickyDecoration by remember { mutableStateOf<StickyHeaderDecoration?>(null) }

    // 已应用到 RecyclerView 的布局模式。与 layoutMode 不一致时触发切换 + FLIP。
    var appliedMode by remember { mutableStateOf(layoutMode) }

    val cols = if (containerWidthDp > 0) targetCols(containerWidthDp, level) else 0
    // adaptive 当前档位的目标行高（dp → px）。行划分不再进 adapter item（一图一项），
    // 只作为 AuroraAdaptiveLayoutManager 的布局参数与捏合模拟的目标几何。
    val density = context.resources.displayMetrics.density
    val adaptiveRowHeightPx = if (containerWidthDp > 0 && layoutMode == LayoutMode.ADAPTIVE) {
        (adaptiveTargetHeightDp(containerWidthDp, kotlin.math.max(1, cols), gapDp, paddingDp) * density)
            .roundToInt()
    } else {
        0
    }
    // adaptive 目标档位的行高 px（捏合预览用；gapDp/paddingDp 经 rememberUpdatedState 防闭包过期）
    val currentGapDp = rememberUpdatedState(gapDp)
    val currentPaddingDp = rememberUpdatedState(paddingDp)
    fun adaptiveTargetRowHeightPx(widthDp: Int, targetLevel: Int): Int =
        (adaptiveTargetHeightDp(
            widthDp,
            kotlin.math.max(1, targetCols(widthDp, targetLevel)),
            currentGapDp.value,
            currentPaddingDp.value,
        ) * density).roundToInt()

    // 三种模式的 item 序列相同（一图一项 + 分组标题），与布局模式/宽度/档位无关——
    // 换档、切换模式不再重建 item 序列，position 与图的对应关系跨档稳定（跟手预览的前提）。
    val items = remember(images, groupBy, collapsedIds) {
        buildGridItems(images, groupBy, collapsedIds)
    }

    // 长按回调走 rememberUpdatedState：adapter 的 remember 只捕获首帧 lambda，宿主侧
    // 处理函数依赖的选中状态/展示序列会变，必须由这里转发最新引用
    val currentOnItemLongClick = rememberUpdatedState(onItemLongClick)
    // 4.4 下拉刷新动作同理（factory 闭包只创建一次）
    val currentOnPullToRefresh = rememberUpdatedState(onPullToRefresh)

    val adapter = remember {
        FileGridAdapter(
            loader = thumbnailLoader,
            surfaceColor = colors.surface.toArgb(),
            textPrimaryColor = colors.textPrimary.toArgb(),
            textSecondaryColor = colors.textSecondary.toArgb(),
            primaryColor = colors.primary.toArgb(),
            contentColor = colors.content.toArgb(),
            onClick = onItemClick,
            onLongClick = { currentOnItemLongClick.value(it) },
            onToggleGroup = { id ->
                collapsedIds = if (id in collapsedIds) collapsedIds - id else collapsedIds + id
            },
        ).also { it.pinchFlip = pinchFlip }
    }
    // 分组标题位置查询接线（GridSpacingDecoration 的列号/顶距在分组模式下不能走
    // position 算术，见其 KDoc）。decoration 与 adapter 都是 remember 单例，赋值幂等。
    decoration.isFullSpanAt = { adapter.isHeaderAt(it) }

    // 主题换色（M4c）：AuroraTheme.colors 随主题档/系统深色变化时把四色推入 adapter
    // 并全量重绑。adapter 的 remember 无 key，构造色只对首帧有效；applyThemeColors
    // 无变化时 no-op，首组合不会多一次重绑。
    LaunchedEffect(colors) {
        adapter.applyThemeColors(
            colors.surface.toArgb(),
            colors.textPrimary.toArgb(),
            colors.textSecondary.toArgb(),
            colors.primary.toArgb(),
            colors.content.toArgb(),
        )
    }

    // 瀑布流的进度驱动 FLIP：列分配是确定性算法（逐 item 放入最短列），离线模拟出新档位
    // 布局做逐 item 跟手。依赖 adapter 的宽高比查询，必须在 adapter 之后创建。
    val masonryPinch = remember {
        MasonryPinchController(
            ratioAt = { adapter.aspectRatioAt(it) },
            isHeaderAt = { adapter.isHeaderAt(it) },
        )
    }
    adapter.masonryPinch = masonryPinch

    // 自适应视图的进度驱动 FLIP：行装箱是确定性算法（贪心累加成行 + 整行拉伸），与
    // AuroraAdaptiveLayoutManager 共用 packAdaptiveRowAt 一份数学，离线模拟目标档位
    // 行划分做逐 item 跟手（架构与 masonry 对称，见 AdaptiveGrid.kt）。
    val adaptivePinch = remember {
        AdaptivePinchController(
            ratioAt = { adapter.aspectRatioAt(it) },
            isHeaderAt = { adapter.isHeaderAt(it) },
        )
    }
    adapter.adaptivePinch = adaptivePinch

    // adaptive 卡片的文件名文字区高度：与 buildPhotoView 的 name 视图完全同参数离线测量
    //（布局管理器的行推进依赖它，必须与真实渲染逐位一致）。
    val adaptiveTextHeightPx = remember {
        TextView(context).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
            setPadding(context.dp(6), context.dp(6), context.dp(6), context.dp(2))
        }.let { probe ->
            probe.measure(
                View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            )
            probe.measuredHeight
        }
    }

    // 捏合换档的锚点透传（GRID / MASONRY 共用）：onPinchEnd 记录 → update 消费（一次）。
    // 松手换档必须保持同一锚点停在同一屏幕位置，预览与收尾 FLIP 才无缝衔接。
    val pendingPinchAnchor = remember { AnchorOverrideHolder() }

    // 模式切换收尾 FLIP 的代纪：captureModeSwitch 的快照只在「此后布局没有任何变化」时
    // 有效。收尾回调挂在 doOnLayout/OnLayoutChangeListener 上——滚动只重绘不重布局，
    // 回调可能挂起几分钟，直到下一次真正的布局（往往是下一次捏合的落档）才触发；
    // 那时快照早已过期，对着当前布局放 240ms 反向位移会把整屏卡片甩一下。任何捏合
    // （开始/落档）、档位切换、数据变化都递增代纪，回调执行时发现代纪不符即放弃。
    val modeFlipEpoch = remember { EpochHolder() }

    // 注意：cellWidthPx（单元格宽度）**不在 key 里**。换档必然伴随列宽变化，若列宽变化触发
    // submit，全量刷新会重新 bind 所有 item，把 FLIP 的初始位移抹掉（表现为硬切）。
    // 列宽改用 adapter.applyCellWidth 同步到可见 item，不 notify。
    // M8b-23③：数据提交必须在**组合期**同步发生（原在 LaunchedEffect 里，比首帧慢一拍
    // ——进文件夹时 RV 的第一帧画的是空 adapter，肉眼看就是「先闪一段空白再出图」，
    // 序列缓存命中也躲不过这帧；FoldersOverview 同款症状当年是靠 RV 复用掩盖的）。
    // remember 键控与原 LaunchedEffect 完全同键：键不变不重复提交；selectedIds/
    // collapsedIds 不进 key（选择走 updateSelection 增量，同旧行为，避免全量重绑）。
    // submit 自带幂等守卫（参数全等返回 false 不 notify），模式切换的 FLIP 提交路径
    // （update 块内另有一次同步 submit）不受影响。
    val submitChanged = remember(items, layoutMode, gapPx) {
        adapter.submit(items, selectedIds, layoutMode, gapPx, collapsedIds)
    }
    LaunchedEffect(items, layoutMode, gapPx) {
        if (submitChanged) modeFlipEpoch.value++
        // 数据/模式变化后刷新一次滚动条几何：否则「是否够长」要等到用户第一次滚动才更新，
        // 期间滚动条的可显示性停在上一份数据的判定上
        rvHolder.rv?.doOnLayout { scrollbar.sync() }
    }

    LaunchedEffect(selectedIds) {
        adapter.updateSelection(selectedIds)
    }

    DisposableEffect(adapter) {
        onDispose { adapter.cancel() }
    }

    // 查看器退出动画的落点查询（2026-10-08）：注册放 DisposableEffect 而不是 RV factory——
    // 查询只在「关查看器那一刻」执行，那时 RV 早已建好；而 factory 里注册要处理「网格换实例
    // 但 holder 是同一个」的覆盖顺序。令牌比对让每次 dispose 只摘自己那一份，不误擦新格子的。
    val rectQueryToken = remember { Any() }
    DisposableEffect(photoRectQuery, rvHolder) {
        val holder = photoRectQuery
        if (holder != null) {
            holder.owner = rectQueryToken
            holder.query = { id, out ->
                val rv = rvHolder.rv
                rv != null && adapter.photoCoverRectInWindow(rv, id, out)
            }
        }
        onDispose {
            if (holder != null && holder.owner === rectQueryToken) {
                holder.owner = null
                holder.query = null
            }
        }
    }

    // 滚动条叠在网格上层（Box）：只有按在拇指上才吃事件，其余全部放行给 RV。
    Box(modifier = modifier.clipToBounds()) {
        AndroidView(
            factory = { ctx ->
                  // 初始列数/行高按**内容宽**（扣除侧栏）算（同 FoldersOverview，2026-09-20
                  // 修复：整屏宽兜底使进文件夹首帧列数偏大、随后 FLIP 重排闪一下）
              val sidebarPx = if (sidebarVisible) (SIDEBAR_WIDTH_DP.value * density).roundToInt() else 0
              val initialWidthPx = (ctx.resources.displayMetrics.widthPixels - sidebarPx).coerceAtLeast(1)
              val initialCols = targetCols(ctx.pxToDp(initialWidthPx), level)
              decoration.spanCount = initialCols
              val initialRowHeightPx = if (adaptiveRowHeightPx > 0) adaptiveRowHeightPx else {
                  val wDp = ctx.pxToDp(initialWidthPx)
                  (adaptiveTargetHeightDp(
                      wDp,
                      kotlin.math.max(1, targetCols(wDp, level)),
                      gapDp,
                      paddingDp,
                  ) * density).roundToInt()
              }
              RecyclerView(ctx).apply {
                  layoutManager = if (layoutMode == LayoutMode.ADAPTIVE) {                    createAdaptiveLayoutManager(
                          ctx,
                          initialRowHeightPx,
                          adaptiveTextHeightPx,
                          gapPx,
                          { adapter.isHeaderAt(it) },
                          { adapter.aspectRatioAt(it) },
                      ) {
                          rvHolder.rv?.let { rv ->
                              pinchFlip.reapplyPreview(rv)
                              masonryPinch.reapplyPreview(rv)
                              adaptivePinch.reapplyPreview(rv)
                          }
                      }
                  } else {
                      createLayoutManager(
                          layoutMode,
                          ctx,
                          initialCols,
                          gapPx,
                          previewRestorer = {
                              rvHolder.rv?.let {
                                  // GRID / MASONRY 各自的控制器在非捏合期都是空操作
                                  pinchFlip.reapplyPreview(it)
                                  masonryPinch.reapplyPreview(it)
                              }
                          },
                      )
                  }
                  this.adapter = adapter
                  // 见 adapter.PHOTO_POOL_SIZE 的说明：扩容 photo 回收池，吸收预填 strip/重建
                  recycledViewPool.setMaxRecycledViews(
                      FileGridAdapter.TYPE_PHOTO,
                      FileGridAdapter.PHOTO_POOL_SIZE,
                  )
                  // 捏合落档要换全新 LayoutManager（冷启动），旧 LM 的全部 child 会在此刻回收。
                  // 默认 mCachedViews 容量只有 2，落档时几乎全部掉进回收池 → 新 LM 逐个重绑 →
                  // loadInto 在内存缓存逐出时清空重载，表现为「松手后一些图片刷新一下」。
                  // 提到 48（≥ 最大档位一屏的可见数）后，同位置视图经 mCachedViews 复用、
                  // 完全不重走 bind；高度正确性由 onViewAttachedToWindow 归一兜底（不走
                  // bind 的复用路径）。
                  // 2026-09-17 提到 128（2026-09-17 用户报障「捏合时部分图片闪一下像刷新」）：
                  // 瀑布流/自适应捏合期挂载量达 76~115（下方 1.5 屏 + 上方补铺），48 装不下，
                  // 超出部分掉进回收池被 onViewRecycled 清空位图，同位置重绑时走异步重载
                  // ——捏合开始/落档时的一波可见闪现（日志 [ImgLoad] ASYNC-RELOAD 实证）。
                  // 128 覆盖全部挂载 view → 冷启动/补铺全程 mCachedViews 同位置复用，
                  // 不重绑、不清位图，闪现消失。代价：缓存 view 保留位图（≤128 张缩略图，
                  // ~0.5-1MB/张），adapter 数据变化（notifyDataSetChanged）时缓存整体清空回收。
                  setItemViewCacheSize(128)
                  addItemDecoration(decoration)
                  setPadding(paddingPx, paddingPx + topInsetPx, paddingPx, paddingPx)
                  clipToPadding = false
                  // 整页滚动联动（3.3fix③）：dy 原样回传宿主，由宿主累计成 scrollY 驱动头部平移
                  addOnScrollListener(gridScrollForwarder)
                  // 裁剪双保险：滚出 RV 顶边的内容不得画进标题/chip 行（Compose interop 链路
                  // 默认不裁剪）。clipToOutline 的 outline 必须显式给 rect——RV 无背景时
                  // BACKGROUND provider 拿到的是 null outline，clipToOutline 不生效。
                  clipToOutline = true
                  outlineProvider = object : ViewOutlineProvider() {
                      override fun getOutline(view: View, outline: Outline) {
                          outline.setRect(0, 0, view.width, view.height)
                      }
                  }
                  itemAnimator = null
                  isVerticalScrollBarEnabled = false
                  rvHolder.rv = this
                  // 修复（2026-09-16，进文件夹封面全白只剩文件名）：update 在 RV 完成首次
                  // 布局前运行时 width=0 会提前返回，而 cellWidthPx 只能在 update 里量出；
                  // 3.2 起网格改为「数据就绪才组合」，组合后没有别的重组触发点，update
                  // 就永远不会再跑。这里在首次布局完成时补写量宽 state，强制 update 重跑。
                  doOnLayout { view ->
                      if (measuredWidthDp == 0 && view.width > 0) {
                          measuredWidthDp = view.context.pxToDp(view.width)
                      }
                  }
                  // 宽度变化自愈（2026-09-20，侧栏开合把封面拉成长条）：3.5 的推挤动画逐帧改
                  // 变内容宽度，但那是**纯 layout 变化、不触发 Compose 重组** → update 不重跑
                  // → applyCellWidth 不执行，封面高度停在旧档位（展开=竖长条、收起=横长条，
                  // 动画结束后也不恢复）。两层处理：
                  //  ① 每次宽度变化立即按**当前 LM span** 重算单元格宽度、走 applyCellWidth
                  //     局部刷新（payload 只刷封面高度：不重载图片、不清 FLIP transform），
                  //     保证动画全程封面都是正方形；
                  //  ② 宽度稳定 80ms 后写量宽 state 触发重组 → update 内 targetCols 收敛列数
                  //     （animateSpanChange 带 FLIP 动画）。列数若不收敛，会停在旧值直到某次
                  //     随机重组才「啪」地跳变（用户感知：卡片/文件名突然变大，与面板开合脱节）；
                  //     去抖让它成为动画结束后的确定性受控动画。
                  // post/postDelayed 出布局阶段（layout 中的 requestLayout 会被 RV 吞掉，L8 教训）；
                  // applyCellWidth 值相等自动去重。adaptive 不在此处理：行装箱由其 LM 自理。
                  var pendingSpanSync: Runnable? = null
                  addOnLayoutChangeListener { v, left, _, right, _, oldLeft, _, oldRight, _ ->
                      val newW = right - left
                      if (newW <= 0 || newW == oldRight - oldLeft) return@addOnLayoutChangeListener
                      post {
                          // GRID 封面已是 WRAP_CONTENT 自动正方形（见 coverHeightFor），无需
                          // 逐帧 notify（最小档位上百可见 cell，逐帧重绑就是掉帧来源）；
                          // 瀑布流按宽高比需要显式高度，保留逐帧同步
                          if (currentLayoutMode.value == LayoutMode.GRID) return@post
                          val span = when (val lm = layoutManager) {
                              is GridLayoutManager -> lm.spanCount
                              is StaggeredGridLayoutManager -> lm.spanCount
                              else -> return@post
                          }
                          val inner = v.width - v.paddingLeft - v.paddingRight
                          val cell = ((inner - (span - 1) * currentGapPx.value) / span).coerceAtLeast(1)
                          adapter.applyCellWidth(v as RecyclerView, cell)
                      }
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
                  // 同时挂两条分发路径，覆盖「第一指落在 item 上」与「落在网格间隙上」两种情况
                  val pinch = PinchGridSpanListener(
                      context = ctx,
                      onPinchStart = { _, _ ->
                          // 任何捏合手势都使未决的模式切换收尾 FLIP 过期（见 modeFlipEpoch 的说明）
                          modeFlipEpoch.value++
                          // 进度驱动（跟手）覆盖面：
                          //  - GRID + 无分组：行号公式直接算目标位置；
                          //  - MASONRY：列分配是确定性算法（逐 item 放入最短列），离线模拟目标位置；
                          //  - ADAPTIVE：行装箱是确定性算法（贪心累加成行 + 整行拉伸），离线模拟
                          //    目标档位行划分（含分组标题行）；
                          //  - 分组 GRID：标题占整行走行号公式会错位 → 只做松手换档。
                          when {
                              currentLayoutMode.value == LayoutMode.GRID &&
                                  currentGroupBy.value == GroupBy.NONE ->
                                  rvHolder.rv?.let { rv ->
                                      pinchFlip.begin(rv, currentGapPx.value)
                                      // 列表末端缩小时上方目标区域属于已回收 item，预览填不出
                                      // → 补铺上方若干行（同 FoldersOverview，见 prefillAbove）。
                                      // 截止位置必须按「收拢目标列数」对齐整行：按旧列数取
                                      // span*4 会停在目标几何某行的中间，该行左侧缺的列在捏合
                                      // 后程露在视口顶（2026-09-17 用户复测：左上角 3 格空白，
                                      // 6→9 列时 until=30 正好卡在目标行 27..35 的中间）。
                                      // 只有收拢方向需要补铺（展开 delta=0），按 level-1 取目标列数；
                                      // 手势最终是展开时多铺的部分会在松手后随布局自然回收，无害。
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
                                          "[FileGrid.pinchStart] GRID level=${currentLevel.value} " +
                                              "beginActive=${pinchFlip.isActive} first=$first " +
                                              "span=${lm?.spanCount} prefillUntil=${lm?.prefillAboveUntilPosition}",
                                      )
                                  }

                              currentLayoutMode.value == LayoutMode.MASONRY ->
                                  rvHolder.rv?.let {
                                      masonryPinch.begin(it, currentGapPx.value)
                                      // 进捏合补一轮预填布局：滚动等增量路径会回收视口下方的预填
                                      // view（无 span 记账的 view 不能参与增量 fill），首次进入
                                      // 瀑布流也还没有预填。不补的话，收拢（列数变多）时可见内容
                                      // 压缩上移、下方没有 item 可插值，底部露出一大段空白直到
                                      // 松手换档。本轮布局会把预览几何洗掉，由 previewRestorer
                                      // 在同一次布局末尾重放，不会闪回原布局。
                                      //
                                      // 上方同理（2026-09-17 用户报障）：末端收拢时钳制位移 δ
                                      // 把目标几何整体下移（实测 1005~1118px），上方目标区域属于
                                      // 已回收 item，视口顶露白 ~600px。按 prefillAboveUntilPosition
                                      // 补铺上方 span*6 个 position（瀑布流无行概念，按列均摊
                                      // 足够盖住 δ + 视口顶），previewRestorer 连新子项一起重放。
                                      val lm = it.layoutManager as? AuroraStaggeredLayoutManager
                                      val first = (it.layoutManager as? StaggeredGridLayoutManager)
                                          ?.findFirstVisibleItemPositions(null)?.minOrNull()
                                          ?: RecyclerView.NO_POSITION
                                      if (lm != null && first != RecyclerView.NO_POSITION) {
                                          lm.prefillAboveUntilPosition =
                                              max(0, first - lm.spanCount * 6)
                                      }
                                      it.requestLayout()
                                      Log.i(
                                          TAG,
                                          "[FileGrid.pinchStart] MASONRY level=${currentLevel.value} " +
                                              "beginActive=${masonryPinch.isActive} first=$first " +
                                              "span=${(it.layoutManager as? StaggeredGridLayoutManager)?.spanCount} " +
                                              "prefillUntil=${lm?.prefillAboveUntilPosition}",
                                      )
                                  }

                              currentLayoutMode.value == LayoutMode.ADAPTIVE ->
                                  rvHolder.rv?.let {
                                      adaptivePinch.begin(it, currentGapPx.value)
                                      // 上方窗口翻倍 + 补一轮布局（2026-09-17 用户报障「自适应
                                      // 收拢时左上角 1~2 张图位置空白、松手才刷新」）：收拢后目标
                                      // 行划分变密，挂载窗口边界（按旧行对齐）正好卡在新行中间，
                                      // 新顶行左侧的 position 没挂载。多探一屏把边界行整体装进
                                      // 窗口（fillVisible 向上回填按完整行走），previewRestorer
                                      // 连新挂载子项一起重放预览几何。与 GRID 1b 的
                                      // prefillUntil 对齐、瀑布流 prefillAbove 同源同理。
                                      val lm = it.layoutManager as? AuroraAdaptiveLayoutManager
                                      if (lm != null) {
                                          lm.pinchExtraAbovePx = it.height
                                          it.requestLayout()
                                      }
                                      Log.i(
                                          TAG,
                                          "[FileGrid.pinchStart] ADAPTIVE level=${currentLevel.value} " +
                                              "beginActive=${adaptivePinch.isActive} children=${it.childCount} " +
                                              "extraAbove=${lm?.pinchExtraAbovePx}",
                                      )
                                  }
                          }
                      },
                      onPinchProgress = { scale, _, _ ->
                          val rv = rvHolder.rv ?: return@PinchGridSpanListener
                          val dir = if (scale >= 1f) 1 else -1
                          val targetLevel = (currentLevel.value + dir).coerceIn(0, 2)
                          // 边界档位（最大/最小）继续缩放：targetLevel 被夹回当前档，目标布局
                          // 与现状完全相同，必须把进度压成 0——否则会产生非零 transform，
                          // 出现「本不该有画面变化却动了一小段」。
                          val progress = if (targetLevel == currentLevel.value) {
                              0f
                          } else {
                              PinchFlipController.progressFor(scale)
                          }
                          // 目标列数必须用 rv 实际宽度算（与 update 里的提交口径一致）。factory 闭包只创建
                          // 一次，直接捕获 containerWidthDp 会拿到首帧的屏宽兜底值——它与 pxToDp(rv.width)
                          // 差一个舍入，导致捏合预览列数与松手提交列数不一致，换档跳位错乱。
                          val widthDp = rv.context.pxToDp(rv.width)
                          when {
                              pinchFlip.isActive -> pinchFlip.update(
                                  rv,
                                  targetLevel,
                                  targetCols(widthDp, targetLevel),
                                  progress,
                              )

                              masonryPinch.isActive -> masonryPinch.update(
                                  rv,
                                  targetLevel,
                                  targetCols(widthDp, targetLevel),
                                  progress,
                              )

                              adaptivePinch.isActive -> adaptivePinch.update(
                                  rv,
                                  targetLevel,
                                  adaptiveTargetRowHeightPx(widthDp, targetLevel),
                                  progress,
                              )
                          }
                      },
                      onPinchEnd = { scale ->
                          val rv = rvHolder.rv ?: return@PinchGridSpanListener
                          Log.i(
                              TAG,
                              "[FileGrid.pinchEnd] scale=$scale level=${currentLevel.value} " +
                                  "grid=${pinchFlip.isActive} masonry=${masonryPinch.isActive} " +
                                  "adaptive=${adaptivePinch.isActive}",
                          )
                          // 捏合结束关闭上方补铺（后续换档布局按默认行为）
                          (rv.layoutManager as? AuroraGridLayoutManager)?.prefillAboveUntilPosition =
                              RecyclerView.NO_POSITION
                          (rv.layoutManager as? AuroraStaggeredLayoutManager)?.prefillAboveUntilPosition =
                              RecyclerView.NO_POSITION
                          (rv.layoutManager as? AuroraAdaptiveLayoutManager)?.pinchExtraAbovePx = 0
                          // 落档：收尾只跑剩余那段进度，清捏合状态（保留 transform 供换档 FLIP 从当前位置收尾）
                          fun commitFlip(target: Int, progress: Float) {
                              val remaining = 1f - progress
                              flipDurationMs =
                                  (FLIP_DURATION_MS * remaining).toLong().coerceAtLeast(80L)
                              // 换档要用同一个锚点（同一屏幕位置）换新布局，先记下再 release。
                              // top 用 commitAnchorTop：列表末端钉在视口边缘时的钳制值，
                              // 与捏合预览的目标几何一致（原样用捏合 top 会被布局拒绝滚动）。
                              when {
                                  pinchFlip.isActive -> pendingPinchAnchor.value = PinchAnchor(
                                      pinchFlip.pinchAnchorPos,
                                      pinchFlip.commitAnchorTop,
                                  )

                                  masonryPinch.isActive -> pendingPinchAnchor.value = PinchAnchor(
                                      masonryPinch.pinchAnchorPos,
                                      masonryPinch.commitAnchorTop,
                                  )

                                  adaptivePinch.isActive -> pendingPinchAnchor.value = PinchAnchor(
                                      adaptivePinch.pinchAnchorPos,
                                      adaptivePinch.commitAnchorTop,
                                  )
                              }
                              pinchFlip.release()
                              masonryPinch.release()
                              adaptivePinch.release()
                              // 落档换布局，未决的模式切换收尾 FLIP 一并作废
                              modeFlipEpoch.value++
                              Log.i(
                                  TAG,
                                  "[FileGrid.commit] target=$target progress=${"%.2f".format(progress)} " +
                                      "anchor=${pendingPinchAnchor.value?.let { "${it.pos}@${it.top}" }}",
                              )
                              onLevelChange(target)
                          }
                          when {
                              pinchFlip.isActive -> {
                                  val target = pinchFlip.currentTargetLevel
                                  // 过半就落到新档位；但若目标档 == 当前档（已在边界），不 commit，退回
                                  if (pinchFlip.shouldCommit() && target != currentLevel.value) {
                                      commitFlip(target, pinchFlip.currentProgress)
                                  } else {
                                      Log.i(
                                          TAG,
                                          "[FileGrid.settle] GRID target=$target level=${currentLevel.value} " +
                                              "shouldCommit=${pinchFlip.shouldCommit()} p=${pinchFlip.currentProgress}",
                                      )
                                      pinchFlip.settle(rv)
                                  }
                              }

                              masonryPinch.isActive -> {
                                  val target = masonryPinch.currentTargetLevel
                                  if (masonryPinch.shouldCommit() && target != currentLevel.value) {
                                      commitFlip(target, masonryPinch.currentProgress)
                                  } else {
                                      Log.i(
                                          TAG,
                                          "[FileGrid.settle] MASONRY target=$target level=${currentLevel.value} " +
                                              "shouldCommit=${masonryPinch.shouldCommit()} p=${masonryPinch.currentProgress}",
                                      )
                                      masonryPinch.settle(rv)
                                  }
                              }

                              adaptivePinch.isActive -> {
                                  val target = adaptivePinch.currentTargetLevel
                                  if (adaptivePinch.shouldCommit() && target != currentLevel.value) {
                                      commitFlip(target, adaptivePinch.currentProgress)
                                  } else {
                                      Log.i(
                                          TAG,
                                          "[FileGrid.settle] ADAPTIVE target=$target level=${currentLevel.value} " +
                                              "shouldCommit=${adaptivePinch.shouldCommit()} p=${adaptivePinch.currentProgress}",
                                      )
                                      adaptivePinch.settle(rv)
                                  }
                              }

                              else -> {
                                  // 分组 GRID：捏合过阈值直接换一档
                                  val delta = when {
                                      scale > PinchFlipController.STEP_THRESHOLD -> 1
                                      scale < 1f / PinchFlipController.STEP_THRESHOLD -> -1
                                      else -> 0
                                  }
                                  val target = currentLevel.value + delta
                                  if (delta != 0 && target in 0..2) {
                                      modeFlipEpoch.value++
                                      onLevelChange(target)
                                  }
                              }
                          }
                      },
                  )
                  setOnTouchListener(pinch)
                  addOnItemTouchListener(pinch)
                  // 吸顶分组标题的点击折叠：sticky 条是 ItemDecoration 画的、不参与触摸分发，
                  // 点击会穿透到其下方 item（图片=误开查看器、间隙/padding=毫无反应）。DOWN
                  // 命中吸顶条即切换该组折叠并整串拦截（在 pinch 之后注册：单指点击 pinch
                  // 不拦，轮到本监听器；多指捏合时 pinch 先拦，本分支无感）。行内标题未被
                  // 吸顶条覆盖时 hitHeader 返回 -1，点击照常落给标题 item 自带的 OnClickListener。
                  addOnItemTouchListener(object : RecyclerView.SimpleOnItemTouchListener() {
                      override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
                          if (e.actionMasked != MotionEvent.ACTION_DOWN) return false
                          val anchorPos = stickyDecoration?.hitHeader(rv, e.x, e.y) ?: return false
                          val item = adapter.itemAt(anchorPos) as? GridItem.Header ?: return false
                          collapsedIds = if (item.id in collapsedIds) {
                              collapsedIds - item.id
                          } else {
                              collapsedIds + item.id
                          }
                          return true
                      }
                  })
              }.also { rv ->
                  // 挂页面滚动条：attach 只登记一个 OnScrollListener，不碰 RV 既有配置
                  // （整页滚动转发/捏合/吸顶点击/下拉刷新都在上面注册完毕，互不干扰）
                  scrollbar.attach(RvScrollMetrics(rv))
                  // 4.4 下拉刷新：注册在捏合监听器之后——多指事件捏合先拦，轮不到下拉；
                  // 单指顶部下拉捏合监听器放行，由这里接管（见 PullToRefreshListener）
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
              if (rv.width <= 0) return@AndroidView
              // 顶 padding 随 topInsetPx 变化（专题详情：头部量高在 factory 之后，inset 是
              // 后到的；View.setPadding 等值时内部去重，重复调用无害）
              rv.setPadding(paddingPx, paddingPx + topInsetPx, paddingPx, paddingPx)
              spanSyncTick.value // 订阅：侧栏动画结束后由监听器递增，触发本次收敛重算
              val predicting = sidebarVisible != sidebarSynced.value
              val sidebarPx = (SIDEBAR_WIDTH_DP.value * density).roundToInt()
              // 预测中 = 动画进行中：宽度取目标状态的最终值（点按瞬间的 rv.width + 全部增量）
              val widthPx = rv.width + if (predicting) (if (sidebarVisible) -sidebarPx else sidebarPx) else 0
              val widthDp = rv.context.pxToDp(widthPx)
              if (measuredWidthDp != widthDp) measuredWidthDp = widthDp
              val span = targetCols(widthDp, level)

              // 模式切换共用的 LM 构建 + 锚点寄存：scrollToPositionWithOffset 在该 LM 的
              // 首次布局生效，因此换完 LM 的那一刻滚动位置就已锁定，不依赖任何延迟回调
              //（旧实现把锚点定位放进 afterStableLayout 的 doOnLayout 链，回调可能挂起到
              // 很久以后才触发——期间视图停在粗定位甚至原点，表现为「切视图滚回顶部」）。
              fun buildModeLm(target: LayoutMode, anchorIdx: Int, anchorTop: Int): RecyclerView.LayoutManager {
                  val restorer = {
                      pinchFlip.reapplyPreview(rv)
                      masonryPinch.reapplyPreview(rv)
                      adaptivePinch.reapplyPreview(rv)
                  }
                  return if (target == LayoutMode.ADAPTIVE) {
                      val rowH = if (adaptiveRowHeightPx > 0) adaptiveRowHeightPx else {
                          (adaptiveTargetHeightDp(
                              widthDp,
                              kotlin.math.max(1, span),
                              gapDp,
                              paddingDp,
                          ) * density).roundToInt()
                      }
                      createAdaptiveLayoutManager(
                          rv.context,
                          rowH,
                          adaptiveTextHeightPx,
                          gapPx,
                          { adapter.isHeaderAt(it) },
                          { adapter.aspectRatioAt(it) },
                          previewRestorer = restorer,
                      ).also { lm ->
                          // offset 语义（AuroraAdaptiveLayoutManager）：锚点视图 top 的视口坐标
                          if (anchorIdx != RecyclerView.NO_POSITION) {
                              lm.scrollToPositionWithOffset(anchorIdx, anchorTop)
                          }
                      }
                  } else {
                      createLayoutManager(
                          target,
                          rv.context,
                          span,
                          gapPx,
                          isFullSpanAt = { adapter.isHeaderAt(it) },
                          previewRestorer = restorer,
                      ).also { lm ->
                          // Grid/Staggered：offset = 锚点 decorated top − 顶 inset − paddingTop
                          //（与 animateSpanChange/animateStaggeredSpanChange 的粗定位同式，
                          // 滚动钳制的残差由收尾 FLIP 的 scrollBy 修正）。
                          if (anchorIdx != RecyclerView.NO_POSITION) when (lm) {
                              is GridLayoutManager -> lm.scrollToPositionWithOffset(
                                  anchorIdx,
                                  anchorTop - (if (anchorIdx / span > 0) gapPx else 0) - rv.paddingTop,
                              )

                              is StaggeredGridLayoutManager -> lm.scrollToPositionWithOffset(
                                  anchorIdx,
                                  anchorTop - (if (anchorIdx >= span) gapPx else 0) - rv.paddingTop,
                              )
                          }
                      }
                  }
              }

              // 布局模式切换：捕获 FLIP 快照 → 同步换 LayoutManager（含锚点寄存）+ 提交新数据
              // → 确定性收尾动画。必须同步提交：只换 LM 而数据还是旧 item 的话，会出现
              // 「新 LM + 旧数据」的中间帧（例如 adaptive 的行划分没跟上，整屏排布错乱）。
              if (appliedMode != layoutMode) {
                  val snapshot = captureModeSwitch(rv, adapter)
                  val mode = layoutMode
                  appliedMode = mode
                  // 本轮快照的有效代纪：此后任何捏合/落档/数据变化都会使其过期
                  val myEpoch = ++modeFlipEpoch.value
                  val anchorIdx = snapshot.anchorId?.let { adapter.indexOfImage(it) }
                      ?: RecyclerView.NO_POSITION
                  val newLm = buildModeLm(mode, anchorIdx, snapshot.anchorTop.roundToInt())
                  rv.layoutManager = newLm
                  adapter.submit(items, selectedIds, mode, gapPx, collapsedIds)

                  // 收尾 FLIP：等新模式的首次布局刷出来，把每张可见图从旧屏幕位置滑到新位置
                  //（与 React 版一致：只动 translation，240ms / cubic-bezier(0.22,1,0.36,1)）。
                  // runFlipWhenLayoutApplied 是 OnPreDraw 驱动 + 有限重试，不会像 doOnLayout
                  // 链那样无限期挂起；即便因快照过期被跳过，位置也已由锚点寄存保住，只损失动画。
                  runFlipWhenLayoutApplied(
                      rv,
                      FlipSnapshot(anchorIdx, snapshot.anchorTop.roundToInt(), 0, emptyMap(), emptyMap(), emptyMap()),
                      "FLIP-ModeSwitch",
                      0,
                      layoutApplied = { it.layoutManager === newLm && it.childCount > 0 },
                  ) {
                      // 布局期间可能又被切走，snapshot 已失效，放弃
                      if (appliedMode != mode) return@runFlipWhenLayoutApplied
                      // 快照过期（此后发生过捏合/落档/数据变化）也放弃；位置已由锚点寄存保住
                      if (modeFlipEpoch.value != myEpoch) return@runFlipWhenLayoutApplied
                      applyModeSwitchFlip(rv, adapter, snapshot)
                  }
              } else if (!matchesMode(rv.layoutManager, layoutMode)) {
                  // 一致性兜底：appliedMode 已一致但 LM 类型不符。同样要寄存锚点，否则换 LM
                  // 会丢滚动位置（「切视图回到顶部」的另一个来源）。
                  val anchor = captureModeSwitch(rv, adapter)
                  val anchorIdx = anchor.anchorId?.let { adapter.indexOfImage(it) }
                      ?: RecyclerView.NO_POSITION
                  rv.layoutManager = buildModeLm(layoutMode, anchorIdx, anchor.anchorTop.roundToInt())
              }

              when (val lm = rv.layoutManager) {
                  is GridLayoutManager -> {
                      // 分组标题占满整行；每次重建以清掉 SpanSizeLookup 的内部缓存
                      lm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
                          override fun getSpanSize(position: Int): Int =
                              if (adapter.isHeaderAt(position)) lm.spanCount else 1
                      }
                      if (span != lm.spanCount) {
                          val anchor = pendingPinchAnchor.value
                          pendingPinchAnchor.value = null
                          animateSpanChange(rv, lm, decoration, span, flipDurationMs, pinchAnchor = anchor)
                          flipDurationMs = FLIP_DURATION_MS
                      }
                  }

                  is StaggeredGridLayoutManager -> {
                      if (span != lm.spanCount) {
                          val anchor = pendingPinchAnchor.value
                          pendingPinchAnchor.value = null
                          // 冷启动换档（换全新 LM）：真实布局与捏合预览的模拟逐位一致，
                          // FLIP 收尾就是最终布局，不再有「松手后再跳一下」。
                          animateStaggeredSpanChange(
                              rv,
                              lm,
                              decoration,
                              span,
                              flipDurationMs,
                              isFullSpanAt = { adapter.isHeaderAt(it) },
                              gapPx = currentGapPx.value,
                              pinchAnchor = anchor,
                              previewRestorer = { masonryPinch.reapplyPreview(rv) },
                          )
                          flipDurationMs = FLIP_DURATION_MS
                      }
                  }

                  is AuroraAdaptiveLayoutManager -> {
                      // adaptive 落档：行高变化即换全新 LM 冷启动（与瀑布流同构），真实布局与
                      // 捏合预览共用 packAdaptiveRowAt 一份数学，FLIP 收尾零跳变。
                      val wantRowHeight = (adaptiveTargetHeightDp(
                          widthDp,
                          kotlin.math.max(1, span),
                          gapDp,
                          paddingDp,
                      ) * density).roundToInt()
                      if (wantRowHeight > 0 && lm.rowHeightPx != wantRowHeight) {
                          val anchor = pendingPinchAnchor.value
                          pendingPinchAnchor.value = null
                          animateAdaptiveRowChange(
                              rv,
                              lm,
                              wantRowHeight,
                              adaptiveTextHeightPx,
                              gapPx,
                              { adapter.aspectRatioAt(it) },
                              { adapter.isHeaderAt(it) },
                              flipDurationMs,
                              pinchAnchor = anchor,
                              previewRestorer = { adaptivePinch.reapplyPreview(rv) },
                          )
                          flipDurationMs = FLIP_DURATION_MS
                      }
                  }

                  else -> Unit
              }

              // 网格/瀑布流按列铺（span=列数），adaptive 行装箱按整宽（span=1，行间距由
              // decoration 的顶 inset 提供）。
              // 赋值 spanCount 不会自动生效，必须配 invalidateItemDecorations——
              // 否则模式切换后间距仍按旧列数算（换档时 animateXxx 内部已经做了，这里补模式切换的情况）。
              val wantSpan = if (layoutMode == LayoutMode.ADAPTIVE) 1 else span
              if (decoration.spanCount != wantSpan) {
                  decoration.spanCount = wantSpan
                  rv.invalidateItemDecorations()
              }

              // 网格（正方形）/瀑布流（按宽高比）用单元格宽度推导封面高度；adaptive 用行高。
              // 走 applyCellWidth（不 notify）而非 submit——见 LaunchedEffect 处的说明。
              // 用预测宽度 widthPx（非 rv.width）：动画中 cell 与收敛后的 span 保持一致。
              val inner = widthPx - rv.paddingLeft - rv.paddingRight
              val cell = if (layoutMode == LayoutMode.ADAPTIVE) 0
                  else ((inner - (span - 1) * gapPx) / span).coerceAtLeast(1)
              adapter.applyCellWidth(rv, cell)
              if (layoutMode == LayoutMode.ADAPTIVE && adaptiveRowHeightPx > 0) {
                  adapter.applyRowHeight(adaptiveRowHeightPx)
              }

              // sticky 分组标题
              val needSticky = groupBy != GroupBy.NONE
              if (needSticky && stickyDecoration == null) {
                  var refs: HeaderRefs? = null
                  val d = StickyHeaderDecoration(
                      headerPositions = { adapter.headerPositions },
                      createHeader = {
                          buildHeaderView(
                              rv.context,
                              colors.textPrimary.toArgb(),
                              colors.textSecondary.toArgb(),
                          )
                              .also { refs = it }
                              .root
                              // M4c：sticky 标题补 content 底色——原透明背景在顶部时与行内
                              // 首个标题叠影（两份「JPEG/18」错位透出）
                              .apply { setBackgroundColor(colors.content.toArgb()) }
                      },
                      bindHeader = { _, position ->
                          val item = adapter.itemAt(position) as? GridItem.Header
                          if (item != null) {
                              refs?.apply {
                                  // 主题换色（M4c）：装饰创建色可能过期，吸顶重绑时按当前主题重刷
                                  adapter.restyleStickyHeader(this)
                                  title.text = item.title
                                  count.text = "${item.count}"
                                  arrow.text = if (item.id in currentCollapsed.value) "▸" else "▾"
                              }
                          }
                      },
                      headerHeightPx = rv.context.dp(HEADER_HEIGHT_DP),
                  )
                  rv.addItemDecoration(d)
                  stickyDecoration = d
              } else if (!needSticky && stickyDecoration != null) {
                  stickyDecoration?.let { rv.removeItemDecoration(it) }
                  stickyDecoration = null
              }
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
