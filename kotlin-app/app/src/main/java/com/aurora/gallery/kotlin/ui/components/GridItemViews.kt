package com.aurora.gallery.kotlin.ui.components

import android.content.Context
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import kotlin.math.roundToInt

/** 分组标题行高度（dp）。 */
const val HEADER_HEIGHT_DP = 48

/**
 * 写封面高度的唯一入口：改 lp 高度后**必须**把封面和它的直接父容器（frame）都置上强制
 * 测量标志。`View.forceLayout()` 不向子树传播，而 `View.measure` 的缓存按 spec key 复用——
 * 只 force 封面时，若夹在中间的 FrameLayout 本轮 spec 与上次相同（瀑布流各列等宽，回收
 * 复用跨 item/跨列时 spec 几乎总是相同），FrameLayout 会整体跳过 onMeasure，`cover.measure`
 * 根本不被调用，新写入的高度没被消费、渲染沿用**上一条生命周期的过期实测高度**
 *（竖图顶位图被 CENTER_CROP 成横条、文件名紧贴其下），直到下一次 spec 变化的测量才
 * “自己变回去”。这正是捏合预览/滚动中「裁剪闪烁」的根源。
 */
internal fun ImageView.applyCoverHeight(height: Int) {
    layoutParams.height = height
    forceLayout()
    (parent as? View)?.forceLayout()
}

/**
 * 文件名固定宽度（= 列宽）：侧栏开合（3.5）逐帧推挤内容宽度时，name 若用 MATCH_PARENT，
 * 每帧宽度 spec 都在变 → 全部可见 cell 的 TextView 逐帧重新排版文字（level 0 上百个
 * 可见 cell，是「最小档位开合掉帧」的主因）。显式宽度在动画期间保持不变 → measure 的
 * spec 缓存命中、文字排版整体跳过；超宽部分由默认 clipChildren 在 cell 边缘裁掉，
 * settle 后随 applyCellWidth 刷到新值。[widthPx] ≤ 0 时回退 MATCH_PARENT。
 */
internal fun TextView.setCellWidth(widthPx: Int) {
    val lp = layoutParams as? LinearLayout.LayoutParams ?: return
    lp.width = if (widthPx > 0) widthPx else ViewGroup.LayoutParams.MATCH_PARENT
}

/**
 * 封面容器：WRAP 高度永远以封面（第 0 个子 view）为准，MATCH 子项（选中边框/角标）
 * 不参与抬高自身。
 *
 * 背景（2026-09-20 真机「长按多选后部分文件名空白」）：RV/LM 的某些重绑路径给 item
 * 的竖向 spec 是**有界**的（AT_MOST/EXACTLY 行高），此时 MATCH 边框经
 * `ViewGroup.getChildMeasureSpec`（childLP=MATCH → EXACTLY(可用高)）被量成整行高，
 * FrameLayout 的 WRAP 计算把它也折进 max → frame 被抬到整行高 → 名字行分到 0 高、
 * 整段被裁（不绘制、且从无障碍树消失——正是「文件名变空白」）。实测真机复现：
 * 重绑后 frame=451（=整行）、cover bottom=404、name 451..451（零高）。
 * 修复 = 量完把自身高度钳回封面高度：边框/角标本就应与封面同大，封面是该容器
 * 唯一的测量锚（masonry/adaptive/捏合预览给封面的显式高度同样生效）。
 */
internal class CoverFrame @JvmOverloads constructor(
    context: Context,
    attrs: android.util.AttributeSet? = null,
) : FrameLayout(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        val anchor = getChildAt(0) ?: return
        val capped = anchor.measuredHeight + paddingTop + paddingBottom
        if (measuredHeight > capped) {
            setMeasuredDimension(measuredWidth, capped)
            // 关键（2026-09-20 用户复测「选中框缺下边」）：MATCH 子项（选中边框）在 super
            // 里已按**未钳制**的高度量过（有界 spec 下 = EXACTLY 整行高），布局按该测量值
            // 摆放 → 底边描边落在钳制后的容器外、被 clipChildren 裁掉（左/右/上都在、
            // 独缺下边）。按钳制后的尺寸重量 MATCH 子项，让边框与容器同高、底边回到容器内。
            val wSpec = MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY)
            val hSpec = MeasureSpec.makeMeasureSpec(capped, MeasureSpec.EXACTLY)
            for (i in 0 until childCount) {
                val child = getChildAt(i) ?: continue
                val lp = child.layoutParams as? MarginLayoutParams ?: continue
                if (lp.width == ViewGroup.LayoutParams.MATCH_PARENT ||
                    lp.height == ViewGroup.LayoutParams.MATCH_PARENT
                ) {
                    measureChildWithMargins(child, wSpec, 0, hSpec, 0)
                }
            }
        }
    }
}

/** 图片卡片（三种布局模式一图一项，共用同一结构）：封面 + 文件名 + 选中态（边框 + 角标）。 */

// ---- 选中态（对齐桌面 FileGrid.tsx / FoldersOverview.tsx 的 isSelected 分支）----
// 边框 = after:border-[3px] border-blue-400；勾标 = w-6 h-6 bg-blue-600 rounded-full
// border-2 border-white shadow-lg ring-2 ring-blue-400/50（外环在 box 外，这里用
// LayerDrawable 三层近似：外圈 blue-400/50 → 白圈 → blue-600 圆心）；选中文件名 =
// bg-[#2563EB] text-white 圆角胶囊。
internal const val SELECT_BORDER_BLUE = 0xFF60A5FA.toInt() // blue-400
internal const val SELECT_PILL_BLUE = 0xFF2563EB.toInt() // blue-600（#2563EB）

/** 选中描边层（3dp blue-400 圆角矩形，透明填充）。 */
internal fun buildSelectBorder(context: Context, radiusDp: Int): View = View(context).apply {
    background = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(android.graphics.Color.TRANSPARENT)
        setStroke(context.dp(3), SELECT_BORDER_BLUE)
        cornerRadius = context.dp(radiusDp).toFloat()
    }
    visibility = View.GONE
}

/** 勾标：blue-600 圆 + 2dp 白描边 + blue-400/50 外环（ring）+ 投影，居中白色粗勾。 */
internal fun buildCheckBadge(context: Context): View = View(context).apply {
    // 矢量绘制（2026-09-20 用户反馈「勾歪歪扭扭」）：此前用文本字符 ✓，随设备字体
    // 渲染得又细又不正；桌面是 lucide Check 矢量路径（strokeWidth 3 / 14px），这里等比移植
    background = CheckBadgeDrawable(context.resources.displayMetrics.density)
    // 圆形 outline：elevation 投影（近似桌面 shadow-lg）需要实底 outline
    outlineProvider = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
            outline.setOval(0, 0, view.width, view.height)
        }
    }
    elevation = context.dp(6).toFloat()
    visibility = View.GONE
}

/** 勾标绘制：外环 blue-400/50 → 白圈 2dp → blue-600 圆 → 白色圆头勾（lucide Check 等比）。 */
private class CheckBadgeDrawable(private val density: Float) : android.graphics.drawable.Drawable() {
    private val ringPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x8060A5FA.toInt()
    }
    private val whitePaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
    }
    private val bluePaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = SELECT_PILL_BLUE
    }
    private val checkPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        style = android.graphics.Paint.Style.STROKE
        strokeCap = android.graphics.Paint.Cap.ROUND
        strokeJoin = android.graphics.Paint.Join.ROUND
    }
    private val path = android.graphics.Path()

    override fun draw(canvas: android.graphics.Canvas) {
        val b = bounds
        if (b.isEmpty) return
        val cx = b.exactCenterX()
        val cy = b.exactCenterY()
        val s = minOf(b.width(), b.height()).toFloat()
        val d = density
        canvas.drawCircle(cx, cy, s / 2f, ringPaint)
        canvas.drawCircle(cx, cy, s / 2f - 2f * d, whitePaint)
        canvas.drawCircle(cx, cy, s / 2f - 4f * d, bluePaint)
        // lucide Check（24 视口：20,6 → 9,17 → 4,12）缩放到徽标的 58% 并居中
        val f = s * 0.583f / 24f
        path.reset()
        path.moveTo(cx + (20f - 12f) * f, cy + (6f - 11.5f) * f)
        path.lineTo(cx + (9f - 12f) * f, cy + (17f - 11.5f) * f)
        path.lineTo(cx + (4f - 12f) * f, cy + (12f - 11.5f) * f)
        checkPaint.strokeWidth = 3f * f
        canvas.drawPath(path, checkPaint)
    }

    override fun setAlpha(alpha: Int) {}
    @Deprecated("Deprecated in Java")
    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {}
    override fun getOpacity(): Int = android.graphics.PixelFormat.TRANSLUCENT
}

/**
 * 选中文件名胶囊（桌面 `inline-block self-center`：只包住文字、水平居中、与封面留缝）。
 *
 * [cellWidthPx] 是未选中时的固定列宽（v10 性能路径，见 [setCellWidth]）；选中时切到
 * WRAP + 水平居中让胶囊贴文字（选择是低频操作，单 item 重排可接受），未选中恢复。
 * 背景用两层 Drawable：顶层 4dp 透明垫高胶囊与封面的间距（背景不参与测量，
 * 不影响 [AuroraAdaptiveLayoutManager] 依赖的 textHeight 探针），下层才是蓝胶囊。
 */
internal fun TextView.applySelectedName(selected: Boolean, normalTextColor: Int, cellWidthPx: Int) {
    val lp = layoutParams as? LinearLayout.LayoutParams ?: return
    if (selected) {
        background = android.graphics.drawable.LayerDrawable(
            arrayOf(
                GradientDrawable().apply { setColor(android.graphics.Color.TRANSPARENT) },
                GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    setColor(SELECT_PILL_BLUE)
                    cornerRadius = dp(4).toFloat()
                },
            ),
        ).apply {
            val gap = dp(4)
            setLayerInset(1, 0, gap, 0, 0)
        }
        setTextColor(android.graphics.Color.WHITE)
        lp.width = ViewGroup.LayoutParams.WRAP_CONTENT
        lp.gravity = Gravity.CENTER_HORIZONTAL
    } else {
        background = null
        setTextColor(normalTextColor)
        lp.width = if (cellWidthPx > 0) cellWidthPx else ViewGroup.LayoutParams.MATCH_PARENT
        lp.gravity = Gravity.CENTER_HORIZONTAL
    }
}

private fun android.view.View.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
internal class PhotoRefs(
    val root: View,
    val cover: ImageView,
    val border: View,
    val check: View,
    val name: TextView,
)

/** 分组标题行：折叠箭头 + 标题 + 数量。 */
internal class HeaderRefs(
    val root: View,
    val arrow: TextView,
    val title: TextView,
    val count: TextView,
)

/**
 * 构建一个图片卡片（网格卡片 / adaptive 行内单元格共用）。
 *
 * 封面用普通 ImageView 而非 SquareImageView——masonry 与 adaptive 的高度随宽高比变化，
 * 由外部在 bind 时设置 `cover.layoutParams.height`（grid 设为等宽即正方形）。
 */
internal fun buildPhotoView(
    context: Context,
    surfaceColor: Int,
    textPrimaryColor: Int,
    @Suppress("UNUSED_PARAMETER") primaryColor: Int,
): PhotoRefs {
    val radius = context.dp(12).toFloat()

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

    val border = buildSelectBorder(context, radiusDp = 12)
    val check = buildCheckBadge(context)

    val name = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(textPrimaryColor)
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        setPadding(context.dp(6), context.dp(6), context.dp(6), context.dp(2))
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

    return PhotoRefs(root, cover, border, check, name)
}

/** 构建分组标题行（可点击折叠，箭头指示折叠状态）。 */
internal fun buildHeaderView(
    context: Context,
    textPrimaryColor: Int,
    textSecondaryColor: Int,
): HeaderRefs {
    val height = context.dp(HEADER_HEIGHT_DP)

    val arrow = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(textSecondaryColor)
        gravity = Gravity.CENTER
        layoutParams = LinearLayout.LayoutParams(context.dp(20), height)
    }

    val title = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        setTextColor(textPrimaryColor)
        typeface = Typeface.DEFAULT_BOLD
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        setGravity(Gravity.START or Gravity.CENTER_VERTICAL)
        layoutParams = LinearLayout.LayoutParams(0, height, 1f)
    }

    val count = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(textSecondaryColor)
        setGravity(Gravity.END or Gravity.CENTER_VERTICAL)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            height,
        )
    }

    val root = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(context.dp(4), 0, context.dp(8), 0)
        addView(arrow)
        addView(title)
        addView(count)
    }

    return HeaderRefs(root, arrow, title, count)
}

/**
 * Sticky 分组标题：在 RecyclerView 顶部叠加绘制「当前所处分组」的标题。
 *
 * 实现要点（标准 sticky header 做法）：
 *  - 用一个离屏 header view 复用测量与绘制，不在列表里额外挂载 View；
 *  - 锚定分组 = **首个可见 item 之前（含）最近的 header**，用二分查找定位，
 *    避免从 firstPos 倒序扫描（1~2 万项时每帧上万次遍历会拖垮滚动）；
 *  - 当下一个分组标题即将顶到顶部时，把 sticky 标题同步上推，产生「被顶走」的过渡。
 *
 * 吸顶线在 **RV 顶缘（y=0）而非 paddingTop**：clipToPadding=false 时图片会滚进
 * padding 区，从 paddingTop 起画的 sticky 盖不住这段，出现「图片穿过标题栏」
 * （2026-09-26 用户报障）；从 0 起画才把滚过的内容全部压在标题栏之下。
 *
 * 吸顶条由 ItemDecoration 绘制、**不参与触摸分发**——点击会穿透到其下方的 item
 * （正下方是图片=误开查看器、是间隙/padding=毫无反应，同日报障「点击折叠无效果」）。
 * [hitHeader] 供宿主挂 OnItemTouchListener 命中查询：命中即消费并切换该组折叠。
 */
internal class StickyHeaderDecoration(
    private val headerPositions: () -> List<Int>,
    private val createHeader: () -> View,
    private val bindHeader: (View, Int) -> Unit,
    private val headerHeightPx: Int,
) : RecyclerView.ItemDecoration() {

    private var headerView: View? = null

    override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
        val anchor = anchorHeaderPosition(parent) ?: return
        val top = stickyTop(parent, anchor) ?: return
        val width = parent.width - parent.paddingLeft - parent.paddingRight
        if (width <= 0) return

        val view = headerView ?: createHeader().also { headerView = it }
        bindHeader(view, anchor)
        view.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(headerHeightPx, View.MeasureSpec.EXACTLY),
        )
        // 手动 view.draw 以画布原点为自身原点，x/y 都经 translate 摆位：
        // x 对齐内容区（不越左右 padding），y 为吸顶线。
        view.layout(0, 0, width, headerHeightPx)
        c.save()
        c.translate(parent.paddingLeft.toFloat(), top.toFloat())
        view.draw(c)
        c.restore()
    }

    /** 返回点击命中的吸顶标题的 adapter position；未吸顶/未命中返回 -1。 */
    fun hitHeader(rv: RecyclerView, x: Float, y: Float): Int {
        val anchor = anchorHeaderPosition(rv) ?: return -1
        val top = stickyTop(rv, anchor) ?: return -1
        if (y < top || y > top + headerHeightPx) return -1
        return anchor
    }

    /** 锚定分组 = 首个可见 item 之前（含）最近的 header；行内标题完整露出时无 sticky，返回 null。 */
    private fun anchorHeaderPosition(parent: RecyclerView): Int? {
        if (parent.childCount == 0) return null
        val firstPos = parent.getChildAdapterPosition(parent.getChildAt(0))
        if (firstPos == RecyclerView.NO_POSITION) return null
        val anchor = findHeaderBefore(firstPos)
        if (anchor < 0) return null

        // 锚定组的行内标题自身还完整露在吸顶线以下时不画 sticky——否则列表顶端
        // 会出现「行内标题 + sticky 标题」上下两条重复标题（M4c 修复）。此时点击
        // 也应落回真实标题 item（它有自己的 OnClickListener）。
        for (i in 0 until parent.childCount) {
            val child = parent.getChildAt(i)
            if (parent.getChildAdapterPosition(child) == anchor) {
                if (child.top >= parent.paddingTop) return null
                break
            }
        }
        return anchor
    }

    /** sticky 当前吸顶 y；被下一个分组标题完全推出视口顶时返回 null（不绘制/不命中）。 */
    private fun stickyTop(parent: RecyclerView, anchor: Int): Int? {
        var top = 0
        // 下一个分组标题顶上来时，sticky 标题被推走
        for (i in 0 until parent.childCount) {
            val child = parent.getChildAt(i)
            val pos = parent.getChildAdapterPosition(child)
            if (pos > anchor && headerPositions().binarySearch(pos) >= 0 &&
                child.top < parent.paddingTop + headerHeightPx
            ) {
                top = child.top - headerHeightPx
                break
            }
        }
        return if (top + headerHeightPx <= 0) null else top
    }

    /** 返回 ≤ [pos] 的最大 header position，没有则 -1。 */
    private fun findHeaderBefore(pos: Int): Int {
        val positions = headerPositions()
        var lo = 0
        var hi = positions.size - 1
        var ans = -1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (positions[mid] <= pos) {
                ans = positions[mid]
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        return ans
    }
}
