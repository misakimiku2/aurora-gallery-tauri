package com.aurora.gallery.kotlin.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 欢迎向导步骤机纯逻辑单测（启动流程优化 2026-09-29）。
 * 对齐设计文档 docs/启动欢迎流程优化-设计方案.md 4.2：
 * 步序 = 权限 → 偏好 → AI（可跳） → 互联（可跳） → 完成。
 */
class WelcomeFlowStateTest {

    // ===== initial =====

    @Test
    fun `首启未授权 - 从权限步开始`() {
        val s = WelcomeFlowState.initial(permissionGranted = false)
        assertEquals(WelcomeStep.PERMISSION, s.step)
        assertFalse(s.permissionGranted)
    }

    @Test
    fun `已授权（升级用户误入）- 跳过权限步直接进偏好步`() {
        val s = WelcomeFlowState.initial(permissionGranted = true)
        assertEquals(WelcomeStep.PREFERENCES, s.step)
        assertTrue(s.permissionGranted)
    }

    // ===== 权限授予 =====

    @Test
    fun `权限步授权后 - 标记置位并前进到偏好步`() {
        val s = WelcomeFlowState.initial(false).onPermissionGranted()
        assertTrue(s.permissionGranted)
        assertEquals(WelcomeStep.PREFERENCES, s.step)
    }

    @Test
    fun `权限步授权时忽略后续 next（必须先经授权）`() {
        val s = WelcomeFlowState.initial(false)
        assertEquals(s, s.next())
    }

    // ===== 顺序推进 =====

    @Test
    fun `授权后顺序推进 - 偏好到AI到互联到完成`() {
        var s = WelcomeFlowState.initial(false).onPermissionGranted()
        s = s.next()
        assertEquals(WelcomeStep.AI, s.step)
        s = s.next()
        assertEquals(WelcomeStep.CONNECT, s.step)
        s = s.next()
        assertEquals(WelcomeStep.DONE, s.step)
    }

    @Test
    fun `DONE 步 next 幂等`() {
        var s = WelcomeFlowState.initial(false).onPermissionGranted()
            .next().next().next()
        assertEquals(WelcomeStep.DONE, s.step)
        assertEquals(s, s.next())
    }

    // ===== 跳过 =====

    @Test
    fun `跳过仅在 AI 与互联步可用`() {
        val base = WelcomeFlowState.initial(false)
        assertFalse(base.canSkip) // PERMISSION
        val pref = base.onPermissionGranted()
        assertFalse(pref.canSkip) // PREFERENCES
        assertTrue(pref.next().canSkip) // AI
        assertTrue(pref.next().next().canSkip) // CONNECT
    }

    @Test
    fun `AI 步跳过不落盘语义 - 前进一步`() {
        val s = WelcomeFlowState.initial(false).onPermissionGranted().next().skip()
        assertEquals(WelcomeStep.CONNECT, s.step)
    }

    @Test
    fun `权限步与偏好步 skip 幂等`() {
        val base = WelcomeFlowState.initial(false)
        assertEquals(base, base.skip())
        val pref = base.onPermissionGranted()
        assertEquals(pref, pref.skip())
    }

    // ===== 回退 =====

    @Test
    fun `回退沿步序后退 - AI与互联可回偏好步，授权后偏好步不可再回权限步`() {
        val s = WelcomeFlowState.initial(false).onPermissionGranted()
            .next().next() // CONNECT
        assertEquals(WelcomeStep.AI, s.back().step)
        assertEquals(WelcomeStep.PREFERENCES, s.back().back().step)
        // 权限已解决，偏好步即首个可见步：再回停在原地（canBack=false）
        assertEquals(WelcomeStep.PREFERENCES, s.back().back().back().step)
    }

    @Test
    fun `已授权时偏好步为首个可见步 - 不可回退`() {
        val s = WelcomeFlowState.initial(true)
        assertEquals(s, s.back())
        assertTrue(!s.canBack)
    }

    @Test
    fun `权限步与 DONE 步不可回退`() {
        val base = WelcomeFlowState.initial(false)
        assertEquals(base, base.back())
        val done = base.onPermissionGranted().next().next().next()
        assertEquals(done, done.back())
    }

    // ===== 跳到指定步骤（点步骤条回退，对齐桌面 onclick={s < step && setStep(s)}）=====

    @Test
    fun `goTo 可跨步回退 - 互联步点步骤条直接回偏好步`() {
        val s = WelcomeFlowState.initial(false).onPermissionGranted().next().next() // CONNECT
        assertEquals(WelcomeStep.AI, s.goTo(WelcomeStep.AI).step)
        assertEquals(WelcomeStep.PREFERENCES, s.goTo(WelcomeStep.PREFERENCES).step)
    }

    @Test
    fun `goTo 不前进 - 目标靠后或等于当前步时不变`() {
        val ai = WelcomeFlowState.initial(false).onPermissionGranted().next() // AI
        assertEquals(ai, ai.goTo(WelcomeStep.AI))
        assertEquals(ai, ai.goTo(WelcomeStep.CONNECT))
        assertEquals(ai, ai.goTo(WelcomeStep.DONE))
    }

    @Test
    fun `goTo 不指向权限步 - 权限已解决不当回退目标`() {
        val s = WelcomeFlowState.initial(false).onPermissionGranted().next() // AI
        assertEquals(s, s.goTo(WelcomeStep.PERMISSION))
    }

    @Test
    fun `goTo 在 DONE 步幂等`() {
        val done = WelcomeFlowState.initial(false).onPermissionGranted().next().next().next()
        assertEquals(done, done.goTo(WelcomeStep.AI))
    }

    @Test
    fun `canGoTo 与 goTo 判定一致`() {
        val s = WelcomeFlowState.initial(false).onPermissionGranted().next().next() // CONNECT
        assertTrue(s.canGoTo(WelcomeStep.AI))
        assertTrue(s.canGoTo(WelcomeStep.PREFERENCES))
        assertFalse(s.canGoTo(WelcomeStep.PERMISSION))
        assertFalse(s.canGoTo(WelcomeStep.CONNECT))
        assertFalse(s.canGoTo(WelcomeStep.DONE))
    }
}
