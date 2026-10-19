package com.aurora.gallery.kotlin.viewer

// 视频 P5：容器缺陷的「无权限退路」——不改用户的文件，读取时把那几处字节代换成修好后的样子。
//
// 背景：`elst` / `mdat` 两类容器病灶的首选修法一直是**原位写 4 个字节**（`core/src/container_repair.rs`）。
// 但安卓上原位写要权限：作用域存储下改别的 app 建的文件，`MediaStore.createWriteRequest` 是**按单张**
// 授权的，`MANAGE_EXTERNAL_STORAGE` 要用户自己去系统设置里开。验收人的原则很明确 —— 这东西必须**无感**：
// 「下载视频，点开就能看」，不是让他去点什么设置。所以这里加一条**不写盘、不要权限**的退路。
//
// 做法：把 core 判出来的补丁表（偏移 + 该呈现的 4 字节）在 `DataSource.read()` 里盖到刚读出的窗口上。
// ExoPlayer 的 mp4 解析器看到的就是"一个已经修好的容器"，而磁盘上的文件**一个字节都没动**。
//
// 判据不在这里重复：补丁表来自 FFI `planVideoContainerPatches`，与真写走的是同一份
// `container_repair::plan_patches`（有集成测钉"计划 == 真写逐字节一致"）。这里**不许**再实现一遍容器判定。

import android.content.Context
import android.net.Uri
import android.util.Log
import android.util.LruCache
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.TransferListener
import uniffi.aurora_core.planVideoContainerPatches
import java.io.File

/** 一处代换：文件里的绝对偏移 + 读取时该呈现的字节。 */
internal data class PatchWindow(
    val offset: Long,
    val bytes: ByteArray,
    val kind: String,
) {
    override fun equals(other: Any?): Boolean =
        other is PatchWindow && other.offset == offset && other.bytes.contentEquals(bytes) && other.kind == kind

    override fun hashCode(): Int = (offset.hashCode() * 31 + bytes.contentHashCode()) * 31 + kind.hashCode()
}

/**
 * 把与本次读窗口 `[readFrom, readFrom+filled)` 重叠的补丁盖到刚读出的字节上（**纯函数**，单测钉它）。
 *
 * 重叠要按两端裁剪：读窗口可能只覆盖补丁的一部分（ExoPlayer 常按 4 KB 读，而补丁只有 4 字节），
 * 也可能一次读完好几个补丁。偏移是**绝对文件偏移**，`readFrom` 也必须是绝对位置（由
 * [DefaultDataSource.getReadPosition] 在 `super.read` 之前取，见下面的数据源）。
 */
internal fun overlayPatches(buf: ByteArray, readFrom: Long, filled: Int, patches: List<PatchWindow>) {
    if (filled <= 0 || patches.isEmpty()) return
    val readEnd = readFrom + filled
    for (p in patches) {
        val patchEnd = p.offset + p.bytes.size
        val s = maxOf(readFrom, p.offset)
        val e = minOf(readEnd, patchEnd)
        if (e <= s) continue
        val srcStart = (s - p.offset).toInt()
        p.bytes.copyInto(buf, (s - readFrom).toInt(), srcStart, srcStart + (e - s).toInt())
    }
}

/**
 * 补丁表按路径缓存（进程内）。
 *
 * 用 `LruCache` 而不是跟扫描那本台账对接：这条通道要**在播放线程上现取现用**，不该依赖扫描跑没跑过。
 * 缓存不需要防"文件后来被真改了"——真写成功后磁盘上已经是补丁值，再代换一次是同一批字节（幂等），
 * 最坏只是多盖一次。反过来（先代换、后来才拿到写权限）也一样安全。
 */
internal object ContainerPatchStore {

    private const val TAG = "ContainerPatch"
    private val cache = LruCache<String, List<PatchWindow>>(64)

    /** 阻塞（要读 moov 与顶层 box 链），**只在 ExoPlayer 的加载线程上调**，别在主线程调。 */
    fun patchesFor(path: String): List<PatchWindow> {
        cache.get(path)?.let { return it }
        val list = runCatching { planVideoContainerPatches(path) }
            .onFailure { Log.w(TAG, "取补丁计划失败 ${it.javaClass.simpleName} ${it.message} path=$path") }
            .getOrDefault(emptyList())
            .map { PatchWindow(it.offset, it.bytes, it.kind) }
        cache.put(path, list)
        if (list.isNotEmpty()) {
            Log.i(
                TAG,
                "原位写不可用 → 播放时虚拟代换 ${list.size} 处 kinds=" +
                    list.joinToString(",") { it.kind } + " :: " + File(path).name,
            )
        }
        return list
    }
}

/**
 * 在默认数据源之外叠一层字节代换。
 *
 * **只能包，不能继承**：media3 1.4.1 里 `DefaultDataSource` 与 `FileDataSource` 都是 final。
 * 于是这里持有一台 `DefaultDataSource` 逐方法转交，只在 `read()` 出来的缓冲区上动手 ——
 * 开文件、定位、长度、EOF、重定向、传输监听全部仍由它维持。
 *
 * 本地档的 URL 恒是文件路径（`ImageItem.path`，无 scheme），LAN 档另有一台播放器走默认工厂；
 * 底层仍用 DefaultDataSource，所以真遇到 `content://` 也不至于打不开。
 */
private class ContainerOverlayDataSource(context: Context) : DataSource {

    // media3 1.4.1 没有 `DefaultDataSource(Context)` 单参构造；enableCache=false 就是
    // `DefaultDataSource.Factory(context)` 今天的取值 —— 包一层不许顺手改变缓存行为。
    private val delegate: DataSource = DefaultDataSource(context, /* enableCache = */ false)

    private var patches: List<PatchWindow> = emptyList()

    /**
     * 自己跟读位置。
     *
     * 不是偷懒：media3 1.4.1 的 `DataSource` 接口上**根本没有** `getReadPosition()`（1.3 才有，
     * 1.4 把它从接口里拿掉了），所以位置只能自己按 `dataSpec.position + 已读字节数` 明算。
     * 而代换偏移是**绝对文件偏移**，位置错一格的症状是"明明修好了却仍播到一半定格"，且只在特定
     * 读取边界出现、设备上肉眼抓不住 —— 这套算术与 [overlayPatches] 的 JVM 单测同源。
     */
    private var pos = 0L

    override fun addTransferListener(transferListener: TransferListener) {
        delegate.addTransferListener(transferListener)
    }

    override fun getUri(): Uri? = delegate.uri

    override fun open(dataSpec: DataSpec): Long {
        patches = dataSpec.uri.path?.let { ContainerPatchStore.patchesFor(it) } ?: emptyList()
        val len = delegate.open(dataSpec)
        pos = dataSpec.position
        return len
    }

    override fun read(buffer: ByteArray, bufferOffset: Int, readLength: Int): Int {
        val from = pos
        val n = delegate.read(buffer, bufferOffset, readLength)
        if (n > 0) {
            if (patches.isNotEmpty()) overlayPatches(buffer, from, n, patches)
            pos += n
        }
        return n
    }

    override fun close() {
        patches = emptyList()
        pos = 0L
        delegate.close()
    }
}

/**
 * 造上面那台数据源。
 *
 * 只管 `createDataSource()`：media3 1.4.1 的 `DataSource.Factory` 还没有 `setTransferListener`
 * （1.5 才加），而 ExoPlayer 的缓冲/进度统计走 `MediaSourceEventListener` 那条，不依赖这里转交
 * 监听器 —— 所以不做"看着像对"的假转交。
 */
internal class ContainerOverlayDataSourceFactory(context: Context) : DataSource.Factory {

    // 用 applicationContext：工厂会被播放器长期持有，不能拽着 Activity/View 的 context 不放
    private val appContext = context.applicationContext

    override fun createDataSource(): DataSource = ContainerOverlayDataSource(appContext)

}
