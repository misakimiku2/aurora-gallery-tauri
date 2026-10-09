package com.aurora.gallery.kotlin.ui.components

import android.graphics.Rect
import android.graphics.RectF
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.StaggeredGridLayoutManager
import androidx.recyclerview.widget.StaggeredSpanAccess
import com.aurora.gallery.kotlin.ThumbnailLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.aurora_core.Image
import kotlin.math.abs
import kotlin.math.roundToInt

/** 普通可变引用（捏合锚点透传）：变化不需要触发重组，update 里同步读取即可。
 *  FileGrid 与 FoldersOverview 的落档锚点共用（internal 便于同包的 FoldersOverview 复用）。 */
internal class AnchorOverrideHolder {
    var value: PinchAnchor? = null
}

/** 普通可变代纪计数：模式切换收尾 FLIP 的时效守卫（避免触发重组）。 */
internal class EpochHolder {
    var value: Int = 0
}

/**
 * 会在视口之外**多布局一些 item** 的 GridLayoutManager。
 *
 * 为什么需要：捏合缩小（列数变多、卡片变小）时，视口需要**更多** item 才填得满；但捏合期间
 * 我们不触发布局（新档位的位置是算出来的、靠 transform 呈现），RV 不会去补充 item，
 * 于是底部露出空白。让 LM 多布局一些就能补上。
 *
 * 量取**单次捏合的最大档位差（一档）**估算：一次手势只跨一档（如 4→6 或 6→9 列），
 * 卡片高度缩到约一半、列数增加一半，二者相乘 ≈ 2.2 倍的内容压缩，底部需约 1.2 屏才够，
 * 给 1.5 屏留余量；顶部只在放大时被「挤」上去，不需要额外空间，1/3 屏足够普通回滚预加载。
 * 代价是多布局几十个 view，换来的是捏合全程无露白。
 */
internal class AuroraGridLayoutManager(
    context: android.content.Context,
    spanCount: Int,
) : GridLayoutManager(context, spanCount) {

    /** 每轮布局完成后的回调：GRID 捏合预览（真实 measure/layout）被布局洗掉时重放，
     *  与 AuroraStaggeredLayoutManager 的 previewRestorer 对称。非捏合期为空操作。 */
    var previewRestorer: (() -> Unit)? = null

    /**
     * 捏合预览期间，把视口上方补铺到该 position（NO_POSITION = 关闭）。
     *
     * 背景（2026-09-17 用户报障）：在列表末端捏合缩小（列数变多）时，目标布局比当前
     * 短，可见子项的目标行整体上移——上方目标区域属于**已被回收**的更早 item，预览
     * （手动 measure/layout，只动已挂载子项）无法凭空插值出它们，顶部会留一段空白、
     * 松手后卡片又被钳回钉底位置（先上后下的两段式观感）。进捏合时由宿主设为本值并
     * requestLayout，[onLayoutChildren] 末尾手动补铺（整轮 relayout **不消费**
     * calculateExtraLayoutSpace——它只在滚动增量填充时生效，实测 childCount 不变），
     * previewRestorer 连新子项一起重放预览几何：顶端被早先的卡片填住、末端钉在视口底，
     * 捏合全程与落档几何一致。与瀑布流 prefillBelow 完全对称。
     */
    var prefillAboveUntilPosition: Int = RecyclerView.NO_POSITION

    override fun calculateExtraLayoutSpace(
        state: RecyclerView.State,
        extraLayoutSpace: IntArray,
    ) {
        extraLayoutSpace[0] = height / 3
        extraLayoutSpace[1] = height * 3 / 2
    }

    override fun onLayoutChildren(
        recycler: RecyclerView.Recycler,
        state: RecyclerView.State,
    ) {
        super.onLayoutChildren(recycler, state)
        prefillAbove(recycler)
        previewRestorer?.invoke()
    }

    /**
     * 把视口上方直到 [prefillAboveUntilPosition] 的 item 按当前 span 的网格几何补铺
     * 出来（每列从当前最顶 child 向上按行距 pitch 逐格上移；同列的 left/width 取自
     * 该列已挂载 child）。补铺只要求「旧布局位置」正确——随后的 previewRestorer 会把
     * 全部子项（含新补的）按当前进度重放到目标几何。
     */
    private fun prefillAbove(recycler: RecyclerView.Recycler) {
        val until = prefillAboveUntilPosition
        if (until == RecyclerView.NO_POSITION || childCount == 0) return
        val span = spanCount
        val colLeft = IntArray(span)
        val colWidth = IntArray(span)
        val colTop = IntArray(span) { Int.MAX_VALUE }
        var minPos = Int.MAX_VALUE
        for (i in 0 until childCount) {
            val c = getChildAt(i)!!
            val col = getPosition(c) % span
            if (colWidth[col] == 0) {
                colLeft[col] = c.left
                colWidth[col] = c.measuredWidth
            }
            if (c.top < colTop[col]) colTop[col] = c.top
            if (getPosition(c) < minPos) minPos = getPosition(c)
        }
        // 行距：同一列**相邻挂载**两个 child 的 top 差（网格各行等高 → 差即行进距）。
        // 挂载序是 position 升序、同列 child 的 top 随之递增，所以对同列的前后两个
        // child 取 `c.top - t.top`（正数）即可。旧实现条件写成 `c.top < t.top`（当前
        // child 在更上方）——升序挂载下该分支永不触发，pitch 恒 0、每轮入口即 ABORT
        //（2026-09-17 日志 `[PrefillAbove] ABORT pitch=0`：上方补铺从未生效、末端收拢
        // 露白未修复的直接原因；首版修复只翻转了减法、没动条件，同样无效）。
        // abs 兜底：底部布局「先向下铺满再向上回填」时，回填段同列 top 递减，取绝对值
        // 仍等于一个行距。
        val lastInCol = arrayOfNulls<View>(span)
        var pitch = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i)!!
            val col = getPosition(c) % span
            val t = lastInCol[col]
            if (t != null) {
                val d = abs(c.top - t.top)
                if (d > 0 && (pitch == 0 || d < pitch)) pitch = d
            }
            lastInCol[col] = c
        }
        if (pitch <= 0 || minPos == Int.MAX_VALUE) {
            // pitch 算不出（可见 child 不足以推出行距）时补铺直接放弃——末端收拢露白的
            // 候选成因之一，日志保留现场。
            Log.i(TAG, "[PrefillAbove] ABORT pitch=$pitch minPos=$minPos until=$until childCount=$childCount")
            return
        }
        Log.i(TAG, "[PrefillAbove] 开始 until=$until span=$span minPos=$minPos pitch=$pitch childCount=$childCount")
        val inner = width - paddingLeft - paddingRight
        var pos = minPos - 1
        var added = 0
        var guard = 0
        while (pos >= until && pos >= 0 && guard < span * 10) {
            val col = pos % span
            if (colWidth[col] == 0) {
                Log.i(TAG, "[PrefillAbove] 中断 pos=$pos：col=$col 无参照 child")
                break // 该列没有任何参照 child（不应发生）
            }
            val top = colTop[col] - pitch
            val v = try {
                recycler.getViewForPosition(pos)
            } catch (e: Exception) {
                Log.w(TAG, "[PrefillAbove] getViewForPosition($pos) 抛异常，中断", e)
                break
            }
            addView(v)
            // 同列等宽：widthUsed = inner - 列宽，使子项量出与该列一致的内容宽
            measureChildWithMargins(v, inner - colWidth[col], 0)
            layoutDecorated(v, colLeft[col], top, colLeft[col] + colWidth[col], top + v.measuredHeight)
            colTop[col] = top
            pos--
            added++
            guard++
        }
        // filledDownTo = 本轮实际铺到的最小 position（guard 耗尽时 < until 可辨）；
        // covTop 取末位 child（addView 尾插，最后补的 position 最小、几何最靠上）
        Log.i(
            TAG,
            "[PrefillAbove] 完成 added=$added filledDownTo=${pos + 1} guard=$guard " +
                "childCount=$childCount covTop=${getChildAt(childCount - 1)?.top}",
        )
    }
}

internal fun createLayoutManager(
    mode: LayoutMode,
    context: android.content.Context,
    spanCount: Int,
    gapPx: Int,
    isFullSpanAt: (Int) -> Boolean = { false },
    previewRestorer: (() -> Unit)? = null,
): RecyclerView.LayoutManager = when (mode) {
    LayoutMode.MASONRY -> AuroraStaggeredLayoutManager(spanCount, isFullSpanAt, gapPx).apply {
        this.previewRestorer = previewRestorer
    }
    else -> AuroraGridLayoutManager(context, spanCount).apply {
        this.previewRestorer = previewRestorer
    }
}

/**
 * 自适应视图的布局管理器。textHeightPx 是与 buildPhotoView 的 name 视图同参数离线
 * 测出的文字区高度（见 FileGrid 的 adaptiveTextHeightPx），行推进依赖它，必须与真实
 * 渲染逐位一致。
 */
internal fun createAdaptiveLayoutManager(
    context: android.content.Context,
    rowHeightPx: Int,
    textHeightPx: Int,
    gapPx: Int,
    isFullSpanAt: (Int) -> Boolean,
    ratioAt: (Int) -> Float,
    previewRestorer: (() -> Unit)? = null,
): AuroraAdaptiveLayoutManager = AuroraAdaptiveLayoutManager(
    rowHeightPx = rowHeightPx.coerceAtLeast(1),
    textHeightPx = textHeightPx,
    headerHeightPx = context.dp(HEADER_HEIGHT_DP),
    ratioAt = ratioAt,
    isHeaderAt = isFullSpanAt,
    gapPx = gapPx,
    previewRestorer = previewRestorer,
)

/**
 * 视口下方**常驻多布局一些 item** 的 StaggeredGridLayoutManager（与 [AuroraGridLayoutManager] 对称）。
 *
 * 为什么需要：瀑布流捏合缩小（列数变多）时内容压缩约一倍，捏合预览是把可见内容往新档位
 * 位置插值——若布局没有预填，下方会露出大片空白。GRID 版靠
 * `LinearLayoutManager.calculateExtraLayoutSpace`（底部 1.5 屏）解决；但 StaggeredGridLayoutManager
 * **没有这个 hook**（1.3.2 不含该方法），只能在布局完成后手动补：每轮 `onLayoutChildren` 末尾
 * 按与 Staggered 一致的「按 position 顺序放入最短列」规则把下方 1.5 屏补建出来。
 *
 * **预填 view 的识别与回收必须用「`LayoutParams.mSpan == null`」这个结构不变量，不能用 view
 * tag**：预填 view 经 `addView` 挂上、从不参与 span 记账，`mSpan` 恒为 null；而 Staggered 的
 * `fill()` 会在 `addView` 前给每个自己铺的 child 赋 `mSpan`（1.3.2 fill 第 1600 行），所以已挂载
 * child 中 `mSpan == null` ⟺ 预填 view。早期版本用 view tag 识别，但 tag 会经由「换 LM 冷启动」
 * 等非本类回收路径残留在 view 上——新 LM 的正常 fill 从 mCachedViews 复用它时**不重走 bind**、
 * 没人清 tag，它就成了「带预填标记的真实记账 child」；strip 时被误删且绕过 `Span.popStart()`，
 * span 的 mViews 留下幽灵条目，滚动 fill/recycle 记账错位后在 `recycleFromStart` 处 NPE
 *（`lp.mSpan.mViews` 空指针）。每轮布局都预填后该窗口必现，故弃用 tag。
 *
 * 任何增量路径（滚动 fill / 重新布局）开始前先回收预填 view（[stripPrefilled]）：增量 fill 按
 * span 列线再铺同一批 position 会叠出重影——这正是「瀑布流下半屏重叠」的来源。回收前经
 * [StaggeredSpanAccess.clearSpan]（[prefillBelow] 复用时也会）把上一条生命周期残留的 span
 * 引用清空，保证复用态干净。
 *
 * 例外是 `onScrollStateChanged(IDLE)`：stock 会在这里走 `checkForGaps → hasGapsToFix`，
 * 逐 child 解引用 `mSpan`，但该回调拿不到 Recycler、无法先 strip——见下方重写，有预填
 * child 挂载时直接跳过这次检查（1.3.2 中这是布局外进入 gap 检查的唯一入口）。

 *
 * [previewRestorer] 在预填之后回调：捏合预览是手动 measure/layout 改写 child 几何，本轮布局
 * （含补预填触发的那轮）会把它洗掉，回调里按当前进度重放，预览才不会闪回原布局一帧。
 */
internal class AuroraStaggeredLayoutManager(
    spanCount: Int,
    /** pos 是否为满宽 header（分组标题）。预填时它必须占满整行。 */
    private val isFullSpanAt: (Int) -> Boolean,
    /** 单元格间距（px）。预填的测量与链式记账要与 GridSpacingDecoration 完全一致。 */
    private val gapPx: Int,
    /** 每轮布局（含预填）完成后的回调；非捏合期为空操作，见 [MasonryPinchController.reapplyPreview]。 */
    var previewRestorer: (() -> Unit)? = null,
) : StaggeredGridLayoutManager(spanCount, StaggeredGridLayoutManager.VERTICAL) {

    /**
     * 捏合预览期间，把视口上方补铺到该 position（NO_POSITION = 关闭）。
     *
     * 背景（2026-09-17 用户报障）：列表末端收拢（列数变多）时，捏合模拟的滚动钳制位移
     * δ 把目标几何整体下移（实测 1005~1118px），上方目标区域属于**已被回收**的更早
     * item——预览（手动 measure/layout，只动已挂载子项）无法凭空插值它们，视口顶露白
     * ~600px、松手后卡片又被钳回钉底位置。宿主在进捏合时设为本值并 requestLayout，
     * [onLayoutChildren] 末尾手动补铺，previewRestorer 连新子项一起重放预览几何。
     * 与 GRID 的 AuroraGridLayoutManager.prefillAbove / 下方 prefillBelow 完全对称。
     */
    var prefillAboveUntilPosition: Int = RecyclerView.NO_POSITION

    override fun onLayoutChildren(
        recycler: RecyclerView.Recycler,
        state: RecyclerView.State,
    ) {
        stripPrefilled(recycler)
        super.onLayoutChildren(recycler, state)
        prefillBelow(recycler, state.itemCount)
        prefillAbove(recycler)
        previewRestorer?.invoke()
    }

    override fun scrollVerticallyBy(
        dy: Int,
        recycler: RecyclerView.Recycler,
        state: RecyclerView.State,
    ): Int {
        stripPrefilled(recycler)
        return super.scrollVerticallyBy(dy, recycler, state)
    }

    /**
     * stock 在滚动状态变 IDLE 时走 `checkForGaps → hasGapsToFix`，逐个 child 读
     * `lp.mSpan.mIndex`（1.3.2 无判空）。预填 view（`mSpan == null`）在两轮布局/滚动之间
     * 常驻挂载，拖拽松手、停 fling、cancelTouch 等任何一次 IDLE 转换都会踩空 NPE 崩溃。
     * 有预填 child 挂载时跳过本次检查（此回调拿不到 Recycler，无法就地回收）：
     *  - 布局期 gap 检查在 `super.onLayoutChildren` 尾部、`prefillBelow` 之前运行，
     *    当时所有 child 都有 span 记账，gap 修复能力不受影响；
     *  - 滚动期 `scrollVerticallyBy` 已先 strip，无预填时 super 照常检查。
     */
    override fun onScrollStateChanged(state: Int) {
        if (state == RecyclerView.SCROLL_STATE_IDLE && hasPrefilledChild()) return
        super.onScrollStateChanged(state)
    }

    private fun hasPrefilledChild(): Boolean {
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            if (isPrefilled(c)) return true
        }
        return false
    }

    /**
     * 是否为预填 view：Staggered LayoutParams 且未参与 span 记账。见类 KDoc 的不变量说明。
     * 非 Staggered LayoutParams（如模式切换后池里的 GRID view）不在此列。
     */
    private fun isPrefilled(child: View): Boolean {
        val lp = child.layoutParams as? StaggeredGridLayoutManager.LayoutParams ?: return false
        return StaggeredSpanAccess.isSpanUnassigned(lp)
    }

    private fun stripPrefilled(recycler: RecyclerView.Recycler) {
        var stripped = 0
        for (i in childCount - 1 downTo 0) {
            val c = getChildAt(i) ?: continue
            if (isPrefilled(c)) {
                removeAndRecycleView(c, recycler)
                stripped++
            }
        }
        // 捏合开始的那轮布局会 strip 掉全部预填再重铺：超过 mViewCacheSize(48) 的部分
        // 掉进回收池、被 onViewRecycled 清空位图，同位置重绑时走异步重载——瀑布流
        // 「捏合一开始部分图片闪一下」的候选来源，与 [ImgLoad] ASYNC-RELOAD 对照。
        if (stripped > 0) Log.i(TAG, "[PrefillBelow] strip 回收预填 view n=$stripped")
    }

    /** 按最短列优先把视口下方 1.5 屏的 item 补建出来（与 Staggered 分配规则一致）。 */
    private fun prefillBelow(recycler: RecyclerView.Recycler, itemCount: Int) {
        if (childCount == 0 || itemCount <= 0) return
        val span = spanCount
        val inner = width - paddingLeft - paddingRight
        if (inner <= 0) return
        // 与 updateMeasureSpecs 的 mSizePerSpan 一致（整数除法）
        val sizePerSpan = inner / span

        // 各列 decorated 底边（放置线）。满宽 header 之后各列底边一致。
        val colEnd = IntArray(span) { Int.MIN_VALUE }
        var maxPos = -1
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            val pos = getPosition(c)
            if (pos == RecyclerView.NO_POSITION) continue
            if (pos > maxPos) maxPos = pos
            val lp = c.layoutParams as? LayoutParams
            if (lp?.isFullSpan == true || isFullSpanAt(pos)) {
                for (s in 0 until span) colEnd[s] = maxOf(colEnd[s], getDecoratedBottom(c))
            } else {
                // 列号必须用 spanIndex（与 GridSpacingDecoration 一致），decorated left 不唯一
                val col = lp?.spanIndex ?: -1
                if (col in 0 until span) colEnd[col] = maxOf(colEnd[col], getDecoratedBottom(c))
            }
        }
        if (maxPos < 0) return
        // 个别列当前没有可见 child 时以最小列底边兜底，保证该列继续向下铺而不是空着
        var minEnd = Int.MAX_VALUE
        for (s in 0 until span) minEnd = minOf(minEnd, colEnd[s])
        if (minEnd == Int.MAX_VALUE || minEnd == Int.MIN_VALUE) return
        for (s in 0 until span) if (colEnd[s] == Int.MIN_VALUE) colEnd[s] = minEnd

        val limit = colEnd.max() + height * 3 / 2
        var pos = maxPos + 1
        var added = 0
        while (pos < itemCount) {
            var best = 0
            for (s in 1 until span) if (colEnd[s] < colEnd[best]) best = s
            if (colEnd[best] > limit) break
            val v = try {
                recycler.getViewForPosition(pos)
            } catch (e: Exception) {
                Log.w(TAG, "[PrefillBelow] getViewForPosition($pos) 抛异常，中断", e)
                return
            }
            // 复用的 view 可能带着上一条生命周期的 span 引用（换 LM 冷启动的整批回收不走
            // popStart），不清掉的话它同时「看起来已记账」（mSpan 非 null、不被 strip 识别）
            // 又「实际不在任何 span 的 mViews 里」——增量 fill 再铺同一 position 会叠出重影。
            // 清空后它满足「mSpan == null ⟺ 预填 view」的不变量，后续 strip 才能正确回收。
            val lp = v.layoutParams as? StaggeredGridLayoutManager.LayoutParams
            if (lp != null) StaggeredSpanAccess.clearSpan(lp)
            // decoration inset 必须先算（layoutDecoratedWithMargins 会按它定位）
            calculateItemDecorationsForChild(v, Rect())
            if (isFullSpanAt(pos)) {
                addView(v)
                // header 无 inset：内容宽 = inner
                measureChildWithMargins(v, 0, 0)
                val line = colEnd.max()
                layoutDecoratedWithMargins(
                    v, paddingLeft, line,
                    paddingLeft + inner, line + v.measuredHeight,
                )
                for (s in 0 until span) colEnd[s] = line + v.measuredHeight
            } else {
                val leftInset = gapPx * best / span
                val rightInset = gapPx * (span - 1 - best) / span
                // 与 GridSpacingDecoration 同式：分组模式首位是满宽标题，首行图片上方也要顶距
                val topInset = if (isFullSpanAt(0) || pos >= span) gapPx else 0
                addView(v)
                // 与 Staggered 的 measureChildWithDecorationsAndMargin 对齐：
                // 内容宽 = sizePerSpan - 左右 inset（widthUsed 把差额从总宽里扣掉）。
                // 直接用默认 spec 会量成全宽，预填卡片互相压边（「下半屏重叠」的来源之一）。
                measureChildWithMargins(v, inner - (sizePerSpan - leftInset - rightInset), 0)
                val line = colEnd[best]
                layoutDecoratedWithMargins(
                    v, paddingLeft + best * sizePerSpan, line,
                    paddingLeft + (best + 1) * sizePerSpan, line + topInset + v.measuredHeight,
                )
                colEnd[best] = line + topInset + v.measuredHeight
            }
            pos++
            added++
        }
        Log.i(
            TAG,
            "[PrefillBelow] span=$span maxPos=$maxPos added=$added childCount=$childCount " +
                "limit=$limit colEndMax=${colEnd.max()}",
        )
    }

    /**
     * 把视口上方直到 [prefillAboveUntilPosition] 的 item 补铺出来（与 GRID 的
     * prefillAbove、下方 prefillBelow 三方对称）。列选择复刻 1.3.2 LAYOUT_START 的
     * 向上铺语义（放入顶边最低的列、并列取最右，与 MasonryPinchController 向后模拟
     * 一致）；补铺只要求旧布局位置近似正确——随后的 previewRestorer 会把全部子项
     * （含新补的）按当前进度重放到目标几何。
     *
     * 必须在 [prefillBelow] **之后**调用：本方法以「span 已记账的真实 child」为列线
     * 参照，而 prefillBelow 补出的 view 满足 mSpan == null 预填不变量，若先跑上方补铺、
     * prefillBelow 的列收集读到未记账 view 的 spanIndex 会 NPE。新补 view 同样走
     * clearSpan 满足不变量，由 stripPrefilled 在下一轮布局/滚动开头回收。
     */
    private fun prefillAbove(recycler: RecyclerView.Recycler) {
        val until = prefillAboveUntilPosition
        if (until == RecyclerView.NO_POSITION || childCount == 0) return
        val span = spanCount
        val inner = width - paddingLeft - paddingRight
        if (inner <= 0) return
        val sizePerSpan = inner / span

        // 各列最顶 decorated top（只看 span 已记账的真实 child）
        val colLine = IntArray(span) { Int.MAX_VALUE }
        var minPos = Int.MAX_VALUE
        for (i in 0 until childCount) {
            val c = getChildAt(i) ?: continue
            if (isPrefilled(c)) continue
            val pos = getPosition(c)
            if (pos == RecyclerView.NO_POSITION) continue
            if (pos < minPos) minPos = pos
            val lp = c.layoutParams as? LayoutParams
            val col = lp?.spanIndex ?: -1
            if (col !in 0 until span) continue
            if (getDecoratedTop(c) < colLine[col]) colLine[col] = getDecoratedTop(c)
        }
        if (minPos == Int.MAX_VALUE) return
        var minLine = Int.MAX_VALUE
        for (s in 0 until span) if (colLine[s] < minLine) minLine = colLine[s]
        if (minLine == Int.MAX_VALUE) return
        // 个别列当前没有真实 child 时以最小列线兜底，保证该列继续向上铺
        for (s in 0 until span) if (colLine[s] == Int.MAX_VALUE) colLine[s] = minLine

        var pos = minPos - 1
        var added = 0
        var guard = 0
        while (pos >= until && pos >= 0 && guard < span * 10) {
            val v = try {
                recycler.getViewForPosition(pos)
            } catch (e: Exception) {
                Log.w(TAG, "[PrefillAbove] getViewForPosition($pos) 抛异常，中断", e)
                break
            }
            val lp = v.layoutParams as? StaggeredGridLayoutManager.LayoutParams
            if (lp != null) StaggeredSpanAccess.clearSpan(lp)
            calculateItemDecorationsForChild(v, Rect())
            addView(v)
            if (isFullSpanAt(pos)) {
                // 满宽 header：压在所有列线最高者上方，头部与下方 item 间留其顶 inset(gap)
                measureChildWithMargins(v, 0, 0)
                var line = Int.MAX_VALUE
                for (s in 0 until span) if (colLine[s] < line) line = colLine[s]
                val bottom = line - gapPx
                layoutDecoratedWithMargins(v, paddingLeft, bottom - v.measuredHeight, paddingLeft + inner, bottom)
                for (s in 0 until span) colLine[s] = bottom - v.measuredHeight
            } else {
                // 放入顶边最低的列（并列取最右）：与向后模拟的 LAYOUT_START 同序
                var best = span - 1
                for (s in span - 2 downTo 0) if (colLine[s] > colLine[best]) best = s
                val leftInset = gapPx * best / span
                val rightInset = gapPx * (span - 1 - best) / span
                // 与 GridSpacingDecoration 同式：分组模式首位是满宽标题，首行图片上方也要顶距
                val topInset = if (isFullSpanAt(0) || pos >= span) gapPx else 0
                // 同列等宽：widthUsed 把差额从总宽里扣掉（与 prefillBelow 同式）
                measureChildWithMargins(v, inner - (sizePerSpan - leftInset - rightInset), 0)
                // 与下方 item 的间距 = 它的顶 inset（中段列表恒为 gap；首行特例由
                // previewRestorer 重放几何吸收，不追求逐位精确）
                val bottom = colLine[best] - gapPx
                val top = bottom - topInset - v.measuredHeight
                // decorated 左右与 prefillBelow 同式（span 几何推导，不用视图实测值）
                layoutDecoratedWithMargins(
                    v,
                    paddingLeft + best * sizePerSpan,
                    top,
                    paddingLeft + (best + 1) * sizePerSpan,
                    bottom,
                )
                colLine[best] = top
            }
            pos--
            added++
            guard++
        }
        if (added > 0 || minPos > until) {
            Log.i(
                TAG,
                "[PrefillAbove] until=$until span=$span minPos=$minPos added=$added " +
                    "childCount=$childCount topLine=${colLine.min()}",
            )
        }
    }
}

internal fun matchesMode(lm: RecyclerView.LayoutManager?, mode: LayoutMode): Boolean = when (mode) {
    LayoutMode.MASONRY -> lm is StaggeredGridLayoutManager
    LayoutMode.ADAPTIVE -> lm is AuroraAdaptiveLayoutManager
    else -> lm is GridLayoutManager
}

/** 视图切换的 FLIP 快照：锚点图 + 每张可见图的屏幕位置。 */
internal class ModeSwitchSnapshot(
    val anchorId: String?,
    val anchorTop: Float,
    val positions: Map<String, Pair<Float, Float>>,
)

/**
 * 捕获切换前每张可见图的屏幕位置与锚点。锚点语义对齐 React 版 `FileGrid.tsx` 的 FLIP：
 *  A. 视口顶边落在哪张图里（top ≤ 0 < bottom，取 top 最大者）——优先，切换后它停在原
 *     屏幕位置（哪怕半露出）；
 *  B. 顶边落在 padding/间隙里 → 取顶边下方第一张图（top ≥ 0 中最小者）。
 * 旧实现取「top 最小的可见图」：在列表深处它往往是一条几乎完全滚出视口顶的行，把它
 * 钉回原屏幕位置需要锚点定位的钳制补偿，切视图的观感就是「内容被大幅拖走」。
 * 位置带当前 translation，连续快速切换时不会跳。
 */
internal fun captureModeSwitch(
    rv: RecyclerView,
    adapter: FileGridAdapter,
): ModeSwitchSnapshot {
    var straddleId: String? = null
    var straddleTop = Int.MIN_VALUE
    var belowId: String? = null
    var belowTop = Int.MAX_VALUE
    val positions = HashMap<String, Pair<Float, Float>>()
    adapter.forEachVisibleImage(rv, withTranslation = true) { id, view, left, top ->
        positions[id] = left to top
        val t = top.roundToInt()
        if (t <= 0 && view.bottom > 0 && t > straddleTop) {
            straddleTop = t
            straddleId = id
        }
        if (t > 0 && t < belowTop) {
            belowTop = t
            belowId = id
        }
    }
    return when {
        straddleId != null -> ModeSwitchSnapshot(straddleId, straddleTop.toFloat(), positions)
        belowId != null -> ModeSwitchSnapshot(belowId, belowTop.toFloat(), positions)
        else -> ModeSwitchSnapshot(null, 0f, positions)
    }
}

/**
 * 视图切换的收尾 FLIP。调用时机 = 新模式的首次布局已刷出（update 的模式切换分支经
 * `runFlipWhenLayoutApplied` 驱动，确定性触发）；锚点已在换 LM 的同帧经
 * scrollToPositionWithOffset 寄存、首次布局即落在原屏幕位置。这里只做两件事：
 *  1. 锚点残差修正：只有滚动钳制（列表端放不下目标位置）会留残差，scrollBy 尽力贴回
 *    （被滚动边界拒绝时保持钳制位置，位移不作补偿——那是物理上到不了的位置）；
 *  2. 二维 FLIP：每张可见图从「切换前的屏幕位置（含进行中的动画位移）」滑到新布局位置。
 * 与 React 版一致：只动 translation（卡片以新尺寸出现、滑入位），240ms /
 * `PathInterpolator(0.22,1,0.36,1)`。
 */
internal fun applyModeSwitchFlip(
    rv: RecyclerView,
    adapter: FileGridAdapter,
    snap: ModeSwitchSnapshot,
) {
    val views = HashMap<String, View>()
    adapter.forEachVisibleImage(rv, withTranslation = false) { id, view, _, _ ->
        views[id] = view
    }

    // 1. 锚点残差修正。scrollBy 会同步把所有 child 的 top 平移，之后的 FLIP 位移
    //    必须按平移后的位置重新收集，不能拿平移前的位置做换算。
    val anchorView = snap.anchorId?.let { views[it] }
    if (anchorView != null) {
        val drift = anchorView.top - snap.anchorTop.roundToInt()
        if (drift != 0) rv.scrollBy(0, drift)
    }

    // 2. 收集新位置（scrollBy 之后）
    val newPos = HashMap<String, Pair<Float, Float>>()
    adapter.forEachVisibleImage(rv, withTranslation = false) { id, view, left, top ->
        views[id] = view
        newPos[id] = left to top
    }

    // 3. Invert + Play
    for ((id, old) in snap.positions) {
        val view = views[id]
        val new = newPos[id]
        if (view == null || new == null) continue
        val dx = old.first - new.first
        val dy = old.second - new.second
        if (abs(dx) < 1f && abs(dy) < 1f) continue
        view.animate().cancel()
        view.translationX = dx
        view.translationY = dy
        view.animate()
            .translationX(0f)
            .translationY(0f)
            .setDuration(FLIP_DURATION_MS)
            .setInterpolator(FLIP_INTERPOLATOR)
            .start()
    }
}

internal class FileGridAdapter(
    private val loader: ThumbnailLoader,
    // 主题四色用 var（M4c）：适配器被 remember 无 key 持有，构造色只对首帧有效，
    // 主题切换经 [applyThemeColors] 推入并重绑。
    private var surfaceColor: Int,
    private var textPrimaryColor: Int,
    private var textSecondaryColor: Int,
    private var primaryColor: Int,
    private var contentColor: Int,
    private val onClick: (Image, ImageView) -> Unit,
    private val onLongClick: (Image) -> Unit,
    private val onToggleGroup: (String) -> Unit,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    /**
     * 主题换色（M4c）：更新四色并全量重绑。无变化时 no-op——挂载后的首次
     * LaunchedEffect 不触发无谓重绑，也不碰「切换动画依赖 resetFlipTransform 前提」
     * 的幂等约定。attached 视图的重刷落点：文件名色在 applySelectedName（bind 路径）、
     * 封面占位底在 [bindPhoto]、分组标题色在 [bindHeader]。
     */
    fun applyThemeColors(
        surface: Int,
        textPrimary: Int,
        textSecondary: Int,
        primary: Int,
        content: Int,
    ): Boolean {
        if (surfaceColor == surface && textPrimaryColor == textPrimary &&
            textSecondaryColor == textSecondary && primaryColor == primary && contentColor == content
        ) {
            return false
        }
        surfaceColor = surface
        textPrimaryColor = textPrimary
        textSecondaryColor = textSecondary
        primaryColor = primary
        contentColor = content
        notifyDataSetChanged()
        return true
    }

    /** sticky 标题卡按当前主题色重刷（M4c）：StickyHeaderDecoration 的 bind 回调用。 */
    fun restyleStickyHeader(refs: HeaderRefs) {
        refs.title.setTextColor(textPrimaryColor)
        refs.count.setTextColor(textSecondaryColor)
        refs.arrow.setTextColor(textSecondaryColor)
        refs.root.setBackgroundColor(contentColor)
    }

    private val items = mutableListOf<GridItem>()
    private var selectedIds: Set<String> = emptySet()
    private var layoutMode: LayoutMode = LayoutMode.GRID
    private var cellWidthPx: Int = 0

    /** adaptive 档位的目标行高 px（不含文件名文字区）；bind 写封面 lp 高度用。 */
    private var rowHeightPx: Int = 0
    private var gapPx: Int = 0
    private var collapsedIds: Set<String> = emptySet()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** 进度驱动 FLIP 控制器；捏合中新绑定的 item 需要补上当前进度的 transform。 */
    var pinchFlip: PinchFlipController? = null

    /** 瀑布流的进度驱动 FLIP 控制器（与 [pinchFlip] 对称）。 */
    var masonryPinch: MasonryPinchController? = null

    /** 自适应视图的进度驱动 FLIP 控制器（与 [masonryPinch] 对称）。 */
    var adaptivePinch: AdaptivePinchController? = null

    /** 所有分组标题的位置（升序），供 sticky 标题二分查找。 */
    var headerPositions: List<Int> = emptyList()
        private set

    companion object {
        internal const val TYPE_HEADER = 0
        internal const val TYPE_PHOTO = 1

        /** photo 回收池容量：瀑布流预填约 1.5 屏（最小档 9 列时 ~80 个），strip/重建
         *  一次性回收量远超默认池（每类型 5），不够时重建全靠 onCreateViewHolder
         *  重新 inflate——重布局风暴里最贵的一环。 */
        internal const val PHOTO_POOL_SIZE = 160

        /** 局部刷新 payload：只更新封面高度，不重新 bind（不重载图片、不动 FLIP transform）。 */
        private const val PAYLOAD_CELL = "cell"
    }

    /**
     * 提交数据，返回是否真的发生变化——**无变化时不刷新**。
     *
     * 幂等守卫是视图切换 FLIP 的前提：切换时会在 `rv.post` 里同步提交一次并立刻启动动画，
     * 随后 `LaunchedEffect` 又会以相同参数提交一次。若这第二次刷新不被挡住，会给所有 item
     * 重新 bind，`resetFlipTransform` 会把动画的初始位移抹掉——动画直接消失。
     */
    fun submit(
        list: List<GridItem>,
        selection: Set<String>,
        mode: LayoutMode,
        gap: Int,
        collapsed: Set<String>,
    ): Boolean {
        val unchanged = items == list && selectedIds == selection && layoutMode == mode &&
            gapPx == gap && collapsedIds == collapsed
        if (unchanged) return false

        items.clear()
        items.addAll(list)
        selectedIds = selection
        layoutMode = mode
        gapPx = gap
        collapsedIds = collapsed
        headerPositions = items.mapIndexedNotNull { i, it -> if (it is GridItem.Header) i else null }
        notifyDataSetChanged()
        return true
    }

    /**
     * 更新单元格宽度，**只改可见 item 的封面高度，绝不 notifyDataSetChanged**。
     *
     * 这是 FLIP 能跑起来的关键：换档必然伴随列宽变化，若列宽变化走
     * `notifyDataSetChanged`，所有 item 会重新 bind，`resetFlipTransform` 恰好把刚设好的
     * 初始位移抹掉——表现就是「换档完全没有动画，直接硬切」。
     * 新 fill 进来的 item 在 bind 时自然会用到新值，无需刷新已有 item。
     */
    fun applyCellWidth(rv: RecyclerView, cellPx: Int) {        // adaptive 模式用不到列宽（行内宽度由行化结果给出）。这里必须**保留上一次的值**
        // 而不是置 0——否则切回 GRID/MASONRY 时会被误判成「首次量出宽度」而走全量刷新，
        // 把视图切换的 FLIP 打断。
        if (cellPx <= 0) return
        if (cellWidthPx == cellPx) return
        val wasZero = cellWidthPx <= 0
        cellWidthPx = cellPx
        if (wasZero) {
            // 从「未量出宽度」变为有宽度：已有 item 的封面高度还是默认的，必须全量刷新一次
            notifyDataSetChanged()
            return
        }
        // 用带 payload 的局部刷新把可见 item 的封面高度可靠地刷成新值。
        // 不能直接改 layoutParams + requestLayout：update 落在 layout 阶段时 requestLayout 会被 RV 吞掉，
        // 导致旧 item 的封面还停在上一档高度（缩小后出现横屏/竖屏长条，滚走再滚回才恢复）。
        notifyItemRangeChanged(0, items.size, PAYLOAD_CELL)
    }

    /**
     * adaptive 行高同步（不 notify 结构、只 payload 刷封面高度）。
     * 行划分由 [AuroraAdaptiveLayoutManager] 负责，这个值只供 bind 写封面 lp 高度；
     * 走 payload 而非 requestLayout 的理由与 [applyCellWidth] 相同。
     */
    fun applyRowHeight(rowHeight: Int) {
        if (rowHeight <= 0 || rowHeightPx == rowHeight) return
        rowHeightPx = rowHeight
        notifyItemRangeChanged(0, items.size, PAYLOAD_CELL)
    }

    /**
     * 封面高度：瀑布流按宽高比，adaptive 用行高；**网格交回 SquareImageView 按宽度自动
     * 正方形（WRAP_CONTENT）**——高度与宽度在同一轮测量对齐，宽度连续变化（侧栏开合的
     * 逐帧推挤）时零滞后、零 notify，天然免疫容器宽度动画（2026-09-20 抖动修复；此前的
     * 显式 cellWidthPx 高度依赖 notify→重绑跟进，高度滞后宽度一帧，来回微抖）。
     * 捏合预览的插值高度由控制器直接写 lp（显式值优先于 WRAP_CONTENT），不受影响。
     */
    private fun coverHeightFor(image: Image): Int = when (layoutMode) {
        LayoutMode.MASONRY -> (cellWidthPx / aspectRatioOf(image)).toInt()
        LayoutMode.ADAPTIVE -> rowHeightPx
        else -> ViewGroup.LayoutParams.WRAP_CONTENT
    }

    /**
     * 遍历当前可见的每一张图（三种模式一图一项）。
     *
     * @param block 参数依次为：图片 id、承载该图的 view（FLIP 的作用对象）、RV 坐标系下的 left / top
     */
    fun forEachVisibleImage(
        rv: RecyclerView,
        withTranslation: Boolean,
        block: (String, View, Float, Float) -> Unit,
    ) {
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            val tx = if (withTranslation) child.translationX else 0f
            val ty = if (withTranslation) child.translationY else 0f
            // 三种模式一图一项，可见图 = PhotoVH
            val holder = rv.getChildViewHolder(child)
            if (holder is PhotoVH) {
                val image = (items.getOrNull(pos) as? GridItem.Photo)?.image ?: continue
                block(image.id, child, child.left + tx, child.top + ty)
            }
        }
    }

    /**
     * 查看器退出动画的落点：可见卡片里该 id 的**封面**矩形（窗口坐标）。
     *
     * 只查已挂载的可见 child（`rv.children`），不在视口内就返回 false——退出过渡宁可退回
     * 别的落点，也不能拿一个编出来的矩形去飞。用封面而不是 itemView：卡片底下还挂着文件名
     * 一行，落到整行矩形上就和进入动画的起点（同样是封面）不是同一块。
     */
    fun photoCoverRectInWindow(rv: RecyclerView, id: String, out: RectF): Boolean {
        for (i in 0 until rv.childCount) {
            val child = rv.getChildAt(i)
            val pos = rv.getChildAdapterPosition(child)
            if (pos == RecyclerView.NO_POSITION) continue
            if ((items.getOrNull(pos) as? GridItem.Photo)?.image?.id != id) continue
            val cover = (rv.getChildViewHolder(child) as? PhotoVH)?.refs?.cover ?: continue
            if (cover.width <= 0 || cover.height <= 0) continue
            val loc = IntArray(2)
            cover.getLocationInWindow(loc)
            out.set(
                loc[0].toFloat(), loc[1].toFloat(),
                (loc[0] + cover.width).toFloat(), (loc[1] + cover.height).toFloat(),
            )
            return true
        }
        return false
    }

    fun updateSelection(selection: Set<String>) {
        val old = selectedIds
        selectedIds = selection
        val changed = mutableListOf<Int>()
        for (i in items.indices) {
            val item = items[i] as? GridItem.Photo ?: continue
            val id = item.image.id
            if ((id in old) != (id in selection)) changed.add(i)
        }
        changed.forEach { notifyItemChanged(it) }
    }

    fun cancel() = scope.cancel()

    fun itemAt(position: Int): GridItem? = items.getOrNull(position)

    fun isHeaderAt(position: Int): Boolean = items.getOrNull(position) is GridItem.Header

    /** pos → 图片宽高比（瀑布流跟手预览的模拟输入）；越界 / 非 Photo 返回 1f。 */
    fun aspectRatioAt(position: Int): Float =
        (items.getOrNull(position) as? GridItem.Photo)?.image?.let { aspectRatioOf(it) } ?: 1f

    /**
     * 返回该图片所在的 item 下标（抹平 Photo 与 adaptive 行两种 item）。
     *
     * 用于视图切换时把锚点图重新滚进视口——换 LayoutManager 会丢掉滚动位置，
     * 不补这一步的话新旧两屏图片可能完全没有交集，FLIP 会一个都匹配不上。
     */
    fun indexOfImage(id: String): Int {
        for (i in items.indices) {
            val it = items[i]
            if (it is GridItem.Photo && it.image.id == id) return i
        }
        return RecyclerView.NO_POSITION
    }

    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int =
        if (items[position] is GridItem.Header) TYPE_HEADER else TYPE_PHOTO

    private class PhotoVH(val refs: PhotoRefs) : RecyclerView.ViewHolder(refs.root) {
        var job: Job? = null
    }

    private class HeaderVH(val refs: HeaderRefs) : RecyclerView.ViewHolder(refs.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val ctx = parent.context
        // 点击必须走 ViewHolder 的 bindingAdapterPosition（复用后位置会变），
        // 因此先建 ViewHolder 再挂监听，闭包捕获 holder 本身。
        return when (viewType) {
            TYPE_HEADER -> {
                val refs = buildHeaderView(ctx, textPrimaryColor, textSecondaryColor)
                val vh = HeaderVH(refs)
                refs.root.setOnClickListener {
                    val item = items.getOrNull(vh.bindingAdapterPosition) as? GridItem.Header
                    if (item != null) onToggleGroup(item.id)
                }
                vh
            }

            else -> {
                val refs = buildPhotoView(ctx, surfaceColor, textPrimaryColor, primaryColor)
                val vh = PhotoVH(refs)
                refs.root.setOnClickListener {
                    val item = items.getOrNull(vh.bindingAdapterPosition) as? GridItem.Photo
                    // 封面视图一起交出去：查看器的进入过渡要拿它的矩形 + 已经解码好的缩略图
                    if (item != null) onClick(item.image, refs.cover)
                }
                // 4.1 长按：进入编辑模式 / 范围选择的触发器。RV 手指落在 item 上时事件由
                // 子 view 消费，pinch 监听器的 OnTouchListener 路径不参与，长按照常触发。
                refs.root.setOnLongClickListener { v ->
                    val item = items.getOrNull(vh.bindingAdapterPosition) as? GridItem.Photo
                    if (item != null) {
                        v.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
                        onLongClick(item.image)
                        true
                    } else {
                        false
                    }
                }
                vh
            }
        }
    }

    override fun onBindViewHolder(
        holder: RecyclerView.ViewHolder,
        position: Int,
        payloads: MutableList<Any>,
    ) {
        if (payloads.isNotEmpty()) {
            // 局部刷新（PAYLOAD_CELL）：只改封面高度，不重新 bind。
            // 换档（列宽变化）时靠它把旧 item 的封面高度可靠地刷成新值——
            // 直接改 layoutParams + requestLayout 会因「update 落在 layout 阶段」被 RV 吞掉，
            // 导致缩小后封面还带着上一档的高度（横屏/竖屏长条）。
            if (holder is PhotoVH) {
                val image = (items.getOrNull(position) as? GridItem.Photo)?.image ?: return
                holder.refs.cover.applyCoverHeight(coverHeightFor(image))
                holder.refs.name.setCellWidth(cellWidthPx)
                // 选中态一并刷：applyCellWidth 的批量 payload 与选中变更可能落在同一批
                // 更新里，payload 分支不回全量 bind，漏刷会留下过期的边框/勾/名字胶囊
                val selected = image.id in selectedIds
                holder.refs.border.visibility = if (selected) View.VISIBLE else View.GONE
                holder.refs.check.visibility = if (selected) View.VISIBLE else View.GONE
                holder.refs.name.applySelectedName(selected, textPrimaryColor, cellWidthPx)
                forceMeasureOnRebind(holder)
            }
            return
        }
        Log.d(TAG, "[Bind] pos=$position 全量重绑（图片会走 loadInto）")
        onBindViewHolder(holder, position)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        // 清掉 FLIP 动画残留的 transform，否则复用后卡片会停在偏移态
        resetFlipTransform(holder.itemView)

        // 瀑布流下分组标题必须占满整行：StaggeredGrid 没有 SpanSizeLookup，
        // 靠 ItemView 的 LayoutParams.isFullSpan 控制（网格模式走 SpanSizeLookup）。
        // 新建 view 在 bind 时**还没有 LayoutParams**（RV 要到 addView 才赋默认值，
        // buildHeaderView 又是程序化创建），直接 as? 会拿到 null、isFullSpan 静默丢失
        // ——标题按 1 列宽布局、首行各列顶到标题上方（2026-09-26 用户报障「其他视图
        // 或多或少也有错位」的瀑布流成因；仅每个标题 view 的首次 bind 中招，回收
        // 复用后自愈，故呈偶发）。这里兜底造一个 Staggered LP 保证必定写入。
        if (layoutMode == LayoutMode.MASONRY) {
            val isHeader = items.getOrNull(position) is GridItem.Header
            val lp = holder.itemView.layoutParams as? StaggeredGridLayoutManager.LayoutParams
            if (lp != null) {
                lp.isFullSpan = isHeader
            } else {
                holder.itemView.layoutParams =
                    StaggeredGridLayoutManager.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { isFullSpan = isHeader }
            }
        }

        // 捏合进行中新绑定的 item 要补上当前进度的手动布局，否则会以未变换的样子闪现
        pinchFlip?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)
        masonryPinch?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)
        adaptivePinch?.takeIf { it.isActive }?.applyToNewChild(holder.itemView, position)

        when (holder) {
            is HeaderVH -> bindHeader(holder, position)
            is PhotoVH -> bindPhoto(holder, position)
        }
        forceMeasureOnRebind(holder)
    }

    /**
     * 重绑后强制重测。封面高度在 bind 时只写字段（[bindPhoto]）——[SquareImageView] 把
     * 内容级 requestLayout 降级为重绘后，重绑不再有「位图落地 → requestLayout」顺带设置的
     * 强制测量标志；RV fill 复用 view 时若尺寸 spec 与上次相同（同列宽），`View.measure`
     * 会跳过 onMeasure，视图保留**上一个档位/上一轮预览**的过期高度，bind 写入的正确
     * 高度没被消费——捏合起点布局（strip+重绑预填）恰好把过期高度捕获为预览插值起点，
     * 表现为捏合全程裁剪/错位、松手换档大幅跳动（maxDelta ~1800px）。forceLayout 只置
     * 强制标志、不上抛（见 [SquareImageView.requestLayout] 的说明），不会重新引发
     * 整网格重布局风暴。
     */
    private fun forceMeasureOnRebind(holder: RecyclerView.ViewHolder) {
        holder.itemView.forceLayout()
        if (holder is PhotoVH) {
            // frame 也要置强制标志：只 force 封面时，中间的 FrameLayout spec 未变会跳过
            // onMeasure，封面的新高度依旧不被消费（见 applyCoverHeight 的说明）。
            holder.refs.cover.forceLayout()
            (holder.refs.cover.parent as? View)?.forceLayout()
        }
    }

    private fun bindHeader(holder: HeaderVH, position: Int) {
        val item = items[position] as? GridItem.Header ?: return
        // 主题换色（M4c）：标题行视图在 onCreateViewHolder 上色后随池复用，bind 重刷
        restyleStickyHeader(holder.refs)
        holder.refs.title.text = item.title
        holder.refs.count.text = "${item.count}"
        holder.refs.arrow.text = if (item.id in collapsedIds) "▸" else "▾"
    }

    private fun bindPhoto(holder: PhotoVH, position: Int) {
        val item = items[position] as? GridItem.Photo ?: return
        val image = item.image
        holder.refs.name.text = image.name
        // 主题换色（M4c）：封面占位底在 onCreateViewHolder 上色后随池复用，bind 重刷
        holder.refs.cover.setBackgroundColor(surfaceColor)

        val selected = image.id in selectedIds
        holder.refs.border.visibility = if (selected) View.VISIBLE else View.GONE
        holder.refs.check.visibility = if (selected) View.VISIBLE else View.GONE

        // 瀑布流按宽高比推导封面高度；网格用正方形（React 版 itemHeight = colWidth + 40）；
        // adaptive 用行高（宽度由行装箱给出，LM 测量时约束）。
        // 高度值尚未量出时回退到 WRAP_CONTENT，交给 SquareImageView 强制正方形，
        // 避免复用的 cover 带着上一次的显式高度（尤其从瀑布流复用过来）变成非正方形长条。
        val coverH = when {
            layoutMode == LayoutMode.ADAPTIVE && rowHeightPx > 0 -> rowHeightPx
            layoutMode == LayoutMode.ADAPTIVE -> ViewGroup.LayoutParams.WRAP_CONTENT
            cellWidthPx > 0 -> coverHeightFor(image)
            else -> ViewGroup.LayoutParams.WRAP_CONTENT
        }
        holder.refs.cover.applyCoverHeight(coverH)
        holder.refs.name.setCellWidth(cellWidthPx)
        // 选中文件名胶囊（对齐桌面 bg-[#2563EB] 白字）。必须在 setCellWidth 之后：
        // 选中态要把名字宽度从固定列宽切成 WRAP（胶囊只包住文字、水平居中），
        // 先切会被 setCellWidth 覆盖回固定宽，胶囊退化成整行蓝条
        holder.refs.name.applySelectedName(selected, textPrimaryColor, cellWidthPx)

        holder.job?.cancel()
        holder.job = loadInto(holder.refs.cover, image, position) { holder.bindingAdapterPosition == position }
    }


    /**
     * 这个 cover 上真的显示着一张位图。**不能拿 `drawable != null` 判**：
     * `setImageBitmap(null)`（异步重载前的清屏）在现代 AOSP 上留下的是包着 null bitmap
     * 的 BitmapDrawable——drawable 恒非 null，同屏守卫会永久跳过重载，单元格停在占位底
     * （M6a 阶段 4 实机抓到：LAN 双绑序列 bind→recycle→rebind 后该格再也不加载）。
     */
    private fun ImageView.showsBitmap(): Boolean =
        (drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap != null

    /** 异步加载缩略图；[stillValid] 在回调时判定这次加载是否还对应同一张图（防复用错位）。 */
    private fun loadInto(
        cover: ImageView,
        image: Image,
        pos: Int,
        stillValid: () -> Boolean,
    ): Job {
        // M6a 阶段 4：LAN 项的 contentUri 装的是**缩略图 URL**（数据层映射时填入），
        // 走 ThumbnailLoader 的 URL 分支（内存同池 → lan_thumbs 磁盘 → okhttp）；
        // 没有 HD 升级语义（服务端 size=256 即网格尺寸，且 HD 分支吃的是 content://）。
        if (image.contentUri.startsWith("http")) {
            val url = image.contentUri
            val cached = loader.peekMemoryUrl(url)
            if (cached != null) {
                Log.d(TAG, "[ImgLoad] pos=$pos url#${url.hashCode()} memCache 同步上屏")
                cover.setImageBitmap(cached)
                cover.tag = url
                return Job().apply { complete() }
            }
            if (cover.tag == url && cover.showsBitmap()) {
                Log.d(TAG, "[ImgLoad] pos=$pos url#${url.hashCode()} sameOnScreen 跳过")
                return Job().apply { complete() }
            }
            Log.i(TAG, "[ImgLoad] pos=$pos url#${url.hashCode()} ASYNC-RELOAD（闪现候选）")
            cover.setImageBitmap(null)
            cover.tag = url
            return scope.launch {
                val bmp = loader.loadFastUrlLimited(url)
                if (stillValid()) {
                    Log.d(TAG, "[ImgLoad] pos=$pos url#${url.hashCode()} async done bmp=${bmp?.let { "${it.width}x${it.height}" } ?: "null"}")
                    cover.setImageBitmap(bmp)
                } else {
                    Log.d(TAG, "[ImgLoad] pos=$pos url#${url.hashCode()} async done 但位置失效 bmp=${bmp?.let { "${it.width}x${it.height}" } ?: "null"}")
                }
            }
        }
        val imageId = loader.extractImageId(image.contentUri)
        val cached = loader.peekMemory(imageId)
        if (cached != null) {
            Log.d(TAG, "[ImgLoad] pos=$pos id=$imageId memCache 同步上屏")
            cover.setImageBitmap(cached)
            cover.tag = imageId
            return Job().apply { complete() }
        }
        // 视图正在展示同一张图（捏合落档换 LM 的同位置重绑必走这里）时不清空、不重载：
        // 内存缓存对大文件夹必然逐出（131 张 × 2MB > 128MB），清空 → 异步重载（media
        // ~12ms/张、并发 4）就是「松手后一片图片刷新」的直接来源。tag 记录该视图当前
        // 应显示的 imageId，drawable 非空即已上屏，直接沿用。
        if (cover.tag == imageId && cover.showsBitmap()) {
            Log.d(TAG, "[ImgLoad] pos=$pos id=$imageId sameOnScreen 跳过")
            return Job().apply { complete() }
        }
        // 走到这里 = 异步重载 = 该图会先空白再弹回（用户感知为「闪一下/刷新了」）。
        // 典型来源：view 经回收池（onViewRecycled 清了 drawable）后同位置重绑。
        Log.i(TAG, "[ImgLoad] pos=$pos id=$imageId ASYNC-RELOAD（闪现候选）")
        cover.setImageBitmap(null)
        cover.tag = imageId
        return scope.launch {
            val bmp = loader.loadFastLimited(imageId)
            if (stillValid()) cover.setImageBitmap(bmp)
            // 按需高清升级：仅当系统缩略图偏小/缺失（<200px）才为这张图生成 HD（Rust 解码
            // 原图 ~145ms/张），512px 系统缩略图不触发——正常滚动零后台解码，不再整夹预热。
            if (bmp != null && loader.needsUpgrade(bmp)) {
                val hd = loader.generateHd(imageId, image.contentUri)
                if (stillValid() && hd != null) cover.setImageBitmap(hd)
            }
        }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
        // 回收时置强制测量标志：经 mCachedViews 复用（不重走 bind）的 view 也必须重测，
        // 否则同样可能带着过期高度混进新一轮布局（见 forceMeasureOnRebind 的说明）。
        Log.d(TAG, "[Recycle] pos=${holder.bindingAdapterPosition} 进回收池（drawable 将被清空）")
        holder.itemView.forceLayout()
        if (holder is PhotoVH) {
            holder.job?.cancel()
            holder.refs.cover.setImageBitmap(null)
            holder.refs.cover.forceLayout()
        }
    }

    override fun onViewAttachedToWindow(holder: RecyclerView.ViewHolder) {
        // 经 mCachedViews 复用的 view（换档冷启动、预填回收再挂载）**不走 onBindViewHolder**，
        // 封面 lp 高度还带着上一个档位的值（瀑布流下差一整档，如 6 列的 421 混进 4 列布局，
        // 正确应为 559）。fill 会按旧值测量上屏；下一次捏合若选中它当锚点，textHeight 会被
        // 推算成毒值（实测 0/151/202），整张模拟表高度全错——预览把封面插向错误尺寸，
        // 表现为「捏合全程裁剪、松手复原」。attach 发生在 fill 测量该 child 之前，这里按
        // 当前数据归一，兜住所有不经 bind 的复用路径。
        if (holder is PhotoVH) {
            val image = (items.getOrNull(holder.bindingAdapterPosition) as? GridItem.Photo)?.image
            if (image != null) {
                holder.refs.cover.applyCoverHeight(coverHeightFor(image))
                holder.refs.name.setCellWidth(cellWidthPx)
                // 选中态归一（2026-09-20 用户复现「部分选中卡无高亮」）：mCachedViews
                // 同位置复用**不走 bind**，边框/勾/名字胶囊可能停留在选中变化前的状态，
                // 这里按当前 selectedIds 归一（与封面高度归一同一款防御）
                val selected = image.id in selectedIds
                holder.refs.border.visibility = if (selected) View.VISIBLE else View.GONE
                holder.refs.check.visibility = if (selected) View.VISIBLE else View.GONE
                holder.refs.name.applySelectedName(selected, textPrimaryColor, cellWidthPx)
                holder.itemView.forceLayout()
            }
        }
    }
}
