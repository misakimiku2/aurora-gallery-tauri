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
internal fun buildCheckBadge(context: Context): TextView = TextView(context).apply {
    text = "✓"
    setTextColor(android.graphics.Color.WHITE)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    typeface = Typeface.DEFAULT_BOLD
    gravity = Gravity.CENTER
    val inset = context.dp(2)
    background = android.graphics.drawable.LayerDrawable(
        arrayOf(
            GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x8060A5FA.toInt()) },
            GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(android.graphics.Color.WHITE) },
            GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(SELECT_PILL_BLUE) },
        ),
    ).apply {
        setLayerInset(1, inset, inset, inset, inset)
        setLayerInset(2, inset * 2, inset * 2, inset * 2, inset * 2)
    }
    // shadow-lg：外圈有实底 → outline 呈圆形，elevation 投影即可
    elevation = context.dp(6).toFloat()
    visibility = View.GONE
}

/** 选中文件名胶囊（bg-[#2563EB] 白字圆角），未选中回退常规色。 */
internal fun TextView.applySelectedName(selected: Boolean, normalTextColor: Int) {
    background = if (selected) {
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(SELECT_PILL_BLUE)
            cornerRadius = dp(8).toFloat()
        }
    } else {
        null
    }
    setTextColor(if (selected) android.graphics.Color.WHITE else normalTextColor)
}

private fun android.view.View.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
internal class PhotoRefs(
    val root: View,
    val cover: ImageView,
    val border: View,
    val check: TextView,
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
        setPadding(context.dp(4), context.dp(6), context.dp(4), 0)
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
