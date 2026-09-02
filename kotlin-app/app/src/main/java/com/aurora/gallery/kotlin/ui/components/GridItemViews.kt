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

/** 网格卡片 / adaptive 行内单元格：封面 + 文件名 + 选中态（边框 + 角标）。 */
internal class PhotoRefs(
    val root: View,
    val cover: ImageView,
    val border: View,
    val check: TextView,
    val name: TextView,
)

/** adaptive 的一行容器（横向）；行内单元格复用 [PhotoRefs]。 */
internal class AdaptiveRowRefs(
    val root: LinearLayout,
    val cells: MutableList<PhotoRefs>,
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
    primaryColor: Int,
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

    val border = View(context).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(android.graphics.Color.TRANSPARENT)
            setStroke(context.dp(3), primaryColor)
            cornerRadius = radius
        }
        visibility = View.GONE
    }

    val check = TextView(context).apply {
        text = "✓"
        setTextColor(android.graphics.Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(primaryColor)
        }
        visibility = View.GONE
    }

    val name = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(textPrimaryColor)
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        setPadding(context.dp(4), context.dp(6), context.dp(4), 0)
    }

    val frame = FrameLayout(context).apply {
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

/** 构建 adaptive 的行容器（横向 LinearLayout，单元格按需动态补齐）。 */
internal fun buildAdaptiveRowView(context: Context): AdaptiveRowRefs =
    AdaptiveRowRefs(
        LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL },
        mutableListOf(),
    )

/**
 * 保证行容器里至少有 [count] 个单元格，多余的隐藏。
 *
 * 单元格**只创建不销毁**：一行最多几张取决于宽高比（竖图多时可达十余张），
 * 每次 bind 都 removeAllViews 重建会有明显开销。
 */
internal fun AdaptiveRowRefs.ensureCells(
    count: Int,
    context: Context,
    surfaceColor: Int,
    textPrimaryColor: Int,
    primaryColor: Int,
) {
    while (cells.size < count) {
        val cell = buildPhotoView(context, surfaceColor, textPrimaryColor, primaryColor)
        cells.add(cell)
        root.addView(
            cell.root,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT),
        )
    }
    for (i in cells.indices) {
        cells[i].root.visibility = if (i < count) View.VISIBLE else View.GONE
    }
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
 */
internal class StickyHeaderDecoration(
    private val headerPositions: () -> List<Int>,
    private val createHeader: () -> View,
    private val bindHeader: (View, Int) -> Unit,
    private val headerHeightPx: Int,
) : RecyclerView.ItemDecoration() {

    private var headerView: View? = null

    override fun onDrawOver(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
        if (parent.childCount == 0) return

        val firstPos = parent.getChildAdapterPosition(parent.getChildAt(0))
        if (firstPos == RecyclerView.NO_POSITION) return

        val anchor = findHeaderBefore(firstPos)
        if (anchor < 0) return

        val view = headerView ?: createHeader().also { headerView = it }
        bindHeader(view, anchor)

        val width = parent.width - parent.paddingLeft - parent.paddingRight
        if (width <= 0) return
        view.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(headerHeightPx, View.MeasureSpec.EXACTLY),
        )

        // 下一个分组标题顶上来时，sticky 标题被推走
        var top = parent.paddingTop
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

        view.layout(parent.paddingLeft, top, parent.paddingLeft + width, top + headerHeightPx)
        c.save()
        c.translate(0f, top.toFloat())
        view.draw(c)
        c.restore()
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
