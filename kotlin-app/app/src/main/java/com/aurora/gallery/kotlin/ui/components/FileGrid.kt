package com.aurora.gallery.kotlin.ui.components

import android.graphics.Outline
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.aurora_core.Image

/**
 * 图片网格（原生 RecyclerView + GridLayoutManager，对齐系统相册滚动性能）。
 */
@Composable
fun FileGrid(
    images: List<Image>,
    selectedIds: Set<String>,
    thumbnailLoader: ThumbnailLoader,
    onItemClick: (Image) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current

    val gridAdapter = remember {
        ImageAdapter(
            loader = thumbnailLoader,
            surfaceColor = colors.surface.toArgb(),
            textPrimaryColor = colors.textPrimary.toArgb(),
            textSecondaryColor = colors.textSecondary.toArgb(),
            primaryColor = colors.primary.toArgb(),
            onClick = onItemClick,
        )
    }

    LaunchedEffect(images) {
        gridAdapter.submit(images, selectedIds)
    }

    LaunchedEffect(selectedIds) {
        gridAdapter.updateSelection(selectedIds)
    }

    DisposableEffect(gridAdapter) {
        onDispose { gridAdapter.cancel() }
    }

    val isTablet = LocalConfiguration.current.screenWidthDp >= 600
    val gapPx = context.dp(if (isTablet) 16 else 10)
    val paddingPx = context.dp(if (isTablet) 24 else 8)

    // 三档捏合：0=小、1=中、2=大（默认中档）
    var level by remember { mutableIntStateOf(1) }
    val currentLevel = rememberUpdatedState(level)
    val decoration = remember { GridSpacingDecoration(6, gapPx) }

    AndroidView(
        factory = { ctx ->
            val initialCols = targetCols(ctx.pxToDp(ctx.resources.displayMetrics.widthPixels), 1)
            decoration.spanCount = initialCols
            RecyclerView(ctx).apply {
                layoutManager = GridLayoutManager(ctx, initialCols)
                adapter = gridAdapter
                addItemDecoration(decoration)
                setPadding(paddingPx, paddingPx, paddingPx, paddingPx)
                clipToPadding = false
                itemAnimator = null
                isVerticalScrollBarEnabled = false
                setOnTouchListener(
                    PinchGridSpanListener(
                        context = ctx,
                        currentLevel = { currentLevel.value },
                        onLevelChange = { newLevel -> if (newLevel in 0..2) level = newLevel },
                    ),
                )
            }
        },
        update = { rv ->
            val lm = rv.layoutManager as? GridLayoutManager ?: return@AndroidView
            if (rv.width <= 0) return@AndroidView
            val target = targetCols(rv.context.pxToDp(rv.width), level)
            if (target != lm.spanCount) {
                animateSpanChange(rv, lm, decoration, target)
            }
        },
        modifier = modifier,
    )
}

private class ImageAdapter(
    private val loader: ThumbnailLoader,
    private val surfaceColor: Int,
    private val textPrimaryColor: Int,
    private val textSecondaryColor: Int,
    private val primaryColor: Int,
    private val onClick: (Image) -> Unit,
) : RecyclerView.Adapter<ImageAdapter.VH>() {

    private val images = mutableListOf<Image>()
    private var selectedIds: Set<String> = emptySet()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun submit(list: List<Image>, selection: Set<String>) {
        images.clear()
        images.addAll(list)
        selectedIds = selection
        notifyDataSetChanged()
    }

    fun updateSelection(selection: Set<String>) {
        val old = selectedIds
        selectedIds = selection
        val changed = mutableListOf<Int>()
        for (i in images.indices) {
            val id = images[i].id
            if ((id in old) != (id in selection)) changed.add(i)
        }
        changed.forEach { notifyItemChanged(it) }
    }

    fun cancel() = scope.cancel()

    override fun getItemCount(): Int = images.size

    class VH(
        view: View,
        val cover: ImageView,
        val border: View,
        val check: TextView,
        val name: TextView,
    ) : RecyclerView.ViewHolder(view) {
        var job: Job? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val context = parent.context
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

        val vh = VH(root, cover, border, check, name)
        root.setOnClickListener {
            val pos = vh.bindingAdapterPosition
            if (pos != RecyclerView.NO_POSITION) onClick(images[pos])
        }
        return vh
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val image = images[position]
        holder.name.text = image.name

        val selected = image.id in selectedIds
        holder.border.visibility = if (selected) View.VISIBLE else View.GONE
        holder.check.visibility = if (selected) View.VISIBLE else View.GONE

        val imageId = loader.extractImageId(image.contentUri)
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

    override fun onViewRecycled(holder: VH) {
        holder.job?.cancel()
        holder.cover.setImageBitmap(null)
    }
}
