package com.aurora.gallery

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.AttributeSet
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.recyclerview.widget.RecyclerView
import coil.ImageLoader
import coil.request.ImageRequest
import java.io.File

/**
 * 底部横向缩略图条。显示当前图片周围的缩略图，点击跳转。
 */
class ThumbnailStripAdapter(
    private val context: Context,
    private val imageLoader: ImageLoader,
    private val onClick: (Int) -> Unit,
) : RecyclerView.Adapter<ThumbnailStripAdapter.VH>() {

    private val items = mutableListOf<NativeGalleryView.ImageItem>()
    private var highlightedIndex = -1
    private val thumbSizePx: Int = (context.resources.displayMetrics.density * 72).toInt()

    fun submit(newItems: List<NativeGalleryView.ImageItem>, highlight: Int) {
        items.clear()
        items.addAll(newItems)
        highlightedIndex = highlight
        notifyDataSetChanged()
    }

    fun highlight(index: Int) {
        val old = highlightedIndex
        if (old == index) return
        highlightedIndex = index
        if (old >= 0) notifyItemChanged(old)
        if (index >= 0) notifyItemChanged(index)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val container = FrameLayout(parent.context).apply {
            layoutParams = ViewGroup.LayoutParams(thumbSizePx, thumbSizePx)
            setPadding(4, 4, 4, 4)
        }
        val iv = BorderImageView(parent.context).apply {
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#222222"))
        }
        container.addView(iv)
        return VH(container, iv)
    }

    override fun getItemCount(): Int = items.size

    override fun onBindViewHolder(holder: VH, position: Int) {
        val item = items[position]
        holder.imageView.setImageDrawable(null)
        val data: Any = when {
            !item.thumbnailUrl.isNullOrEmpty() -> item.thumbnailUrl
            item.isLan -> item.path
            else -> File(item.path)
        }
        val request = ImageRequest.Builder(context)
            .data(data)
            .target(holder.imageView)
            .build()
        imageLoader.enqueue(request)

        val isHighlight = position == highlightedIndex
        holder.itemView.alpha = if (isHighlight) 1f else 0.55f
        holder.imageView.borderColor = if (isHighlight) Color.WHITE else Color.TRANSPARENT
        holder.itemView.setOnClickListener { onClick(position) }
    }

    class VH(itemView: android.view.View, val imageView: BorderImageView) : RecyclerView.ViewHolder(itemView)
}

/** 简单的带边框 ImageView。 */
class BorderImageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : ImageView(context, attrs) {

    var borderColor: Int = Color.TRANSPARENT
        set(value) {
            field = value
            invalidate()
        }
    private val borderWidthPx = context.resources.displayMetrics.density * 3

    private val borderPaint = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = borderWidthPx
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (borderColor != Color.TRANSPARENT) {
            borderPaint.color = borderColor
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), borderPaint)
        }
    }
}
