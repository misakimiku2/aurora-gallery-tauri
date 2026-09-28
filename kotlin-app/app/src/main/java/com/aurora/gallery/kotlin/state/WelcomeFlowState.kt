package com.aurora.gallery.kotlin.state

/**
 * 欢迎向导步骤（启动流程优化 2026-09-29，设计文档 4.2）：
 * 权限 → 偏好（主题/语言）→ AI 设置（可跳）→ 互联（可跳）→ 完成。
 */
enum class WelcomeStep { PERMISSION, PREFERENCES, AI, CONNECT, DONE }

/**
 * 欢迎向导步骤机（纯 Kotlin 无 Compose 依赖，JUnit 可测；Compose 层持有状态并按
 * [WelcomeStep] 渲染）。跳过 = 不落盘前进一步（仅 AI/CONNECT 两步）；权限步必须经
 * [onPermissionGranted] 推进，拒绝后走「去系统设置」回来再授权，同一步骤。
 */
data class WelcomeFlowState(
    val step: WelcomeStep,
    val permissionGranted: Boolean,
) {
    companion object {
        /** 已授权（老用户误入/系统预授权）直接跳过权限步，从偏好步开始。 */
        fun initial(permissionGranted: Boolean): WelcomeFlowState =
            WelcomeFlowState(
                step = if (permissionGranted) WelcomeStep.PREFERENCES else WelcomeStep.PERMISSION,
                permissionGranted = permissionGranted,
            )
    }

    /** 权限授予回调（launcher 回来）：置位标记；停在权限步则前进到偏好步。 */
    fun onPermissionGranted(): WelcomeFlowState =
        if (step == WelcomeStep.PERMISSION) {
            copy(permissionGranted = true, step = WelcomeStep.PREFERENCES)
        } else {
            copy(permissionGranted = true)
        }

    /** 下一步。DONE 幂等；PERMISSION 步不走此口（无权限不该能离开）。 */
    fun next(): WelcomeFlowState = when (step) {
        WelcomeStep.PERMISSION, WelcomeStep.DONE -> this
        else -> copy(step = WelcomeStep.entries[step.ordinal + 1])
    }

    /** 跳过（AI/CONNECT）：等价 next 但语义上不写任何设置；其他步幂等。 */
    fun skip(): WelcomeFlowState = if (canSkip) next() else this

    /** 回退（指示器/返回键共用）。首个可见步与 DONE 幂等。 */
    fun back(): WelcomeFlowState = when {
        !canBack -> this
        else -> copy(step = WelcomeStep.entries[step.ordinal - 1])
    }

    /** 跳过是否可用（仅 AI/CONNECT 两步——「可选跳过」语义）。 */
    val canSkip: Boolean
        get() = step == WelcomeStep.AI || step == WelcomeStep.CONNECT

    /** 是否尾步（按钮显示「开始使用」而非「下一步」）。 */
    val isLast: Boolean
        get() = step == WelcomeStep.CONNECT

    /** 回退是否可用：权限步/DONE 不可；已授权时偏好步即首个可见步不可。 */
    val canBack: Boolean
        get() = when (step) {
            WelcomeStep.PERMISSION, WelcomeStep.DONE -> false
            WelcomeStep.PREFERENCES -> !permissionGranted
            else -> true
        }
}
