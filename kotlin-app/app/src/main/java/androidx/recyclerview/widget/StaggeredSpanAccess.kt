package androidx.recyclerview.widget

/**
 * 供应用内的 `AuroraStaggeredLayoutManager`（com.aurora.gallery.kotlin.ui.components）读写
 * [StaggeredGridLayoutManager.LayoutParams.mSpan]——该字段是 package-private，应用包无法直接访问。
 *
 * 用途：瀑布流手工预填（视口下方多铺 item）依赖「预填 view 的 `mSpan == null`、正常布局的
 * child 的 `mSpan` 必被 fill 赋值」这一结构不变量来区分两类 child 并安全回收预填 view；
 * 复用上一条生命周期残留的 view 做预填前，必须清掉残留的 span 引用，否则该 view 会带着
 * 已失效的 span 引用混进正常布局，回收时绕过 `Span.popStart()` 记账，最终在
 * `recycleFromStart` 处 NPE。
 *
 * `mSpan` 是 Staggered span 记账的核心字段，androidx 版本间相当稳定；升级 recyclerview
 * 依赖后需回归验证捏合收拢与滚动。
 */
internal object StaggeredSpanAccess {

    /** child 是否**未**参与 span 记账：true = 预填 view；false = Staggered fill 铺的正常 child。 */
    fun isSpanUnassigned(lp: StaggeredGridLayoutManager.LayoutParams): Boolean = lp.mSpan == null

    /** 清掉残留的 span 引用（预填复用前调用）。 */
    fun clearSpan(lp: StaggeredGridLayoutManager.LayoutParams) {
        lp.mSpan = null
    }
}
