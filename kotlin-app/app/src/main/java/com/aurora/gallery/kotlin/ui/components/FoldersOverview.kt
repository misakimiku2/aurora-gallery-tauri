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
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import uniffi.aurora_core.Folder

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
    modifier: Modifier = Modifier,
) {
    val colors = AuroraTheme.colors
    val context = LocalContext.current

    val gridAdapter = remember {
        FolderAdapter(
            loader = thumbnailLoader,
            surfaceColor = colors.surface.toArgb(),
            textPrimaryColor = colors.textPrimary.toArgb(),
            textSecondaryColor = colors.textSecondary.toArgb(),
            onClick = onFolderClick,
        )
    }

    LaunchedEffect(folders) {
        gridAdapter.submit(folders)
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
                    text = "暂无文件夹",
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

private class FolderAdapter(
    private val loader: ThumbnailLoader,
    private val surfaceColor: Int,
    private val textPrimaryColor: Int,
    private val textSecondaryColor: Int,
    private val onClick: (Folder) -> Unit,
) : RecyclerView.Adapter<FolderAdapter.VH>() {

    private val folders = mutableListOf<Folder>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun submit(list: List<Folder>) {
        folders.clear()
        folders.addAll(list)
        notifyDataSetChanged()
    }

    fun cancel() = scope.cancel()

    override fun getItemCount(): Int = folders.size

    class VH(
        view: View,
        val cover: ImageView,
        val count: TextView,
        val name: TextView,
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

        val frame = FrameLayout(context).apply {
            addView(
                cover,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
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

        val vh = VH(root, cover, count, name)
        root.setOnClickListener {
            val pos = vh.bindingAdapterPosition
            if (pos != RecyclerView.NO_POSITION) onClick(folders[pos])
        }
        return vh
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val folder = folders[position]
        holder.name.text = folder.name
        holder.count.text = folder.imageCount.toString()
        holder.count.visibility = if (folder.imageCount > 0) View.VISIBLE else View.GONE

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
    }

    override fun onViewRecycled(holder: VH) {
        holder.job?.cancel()
        holder.cover.setImageBitmap(null)
    }
}
