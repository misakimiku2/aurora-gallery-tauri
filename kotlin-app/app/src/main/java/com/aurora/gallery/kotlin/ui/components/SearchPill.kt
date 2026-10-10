package com.aurora.gallery.kotlin.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.state.SearchScope
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme

/** 搜索胶囊（React 安卓 `isSearchOpen` 时的中央输入；自动聚焦弹键盘，X 关闭并清词）。 */
@Composable
internal fun SearchPill(
    query: String,
    onQueryChange: (String) -> Unit,
    placeholder: String,
    scope: SearchScope = SearchScope.ALL,
    onScopeChange: (SearchScope) -> Unit = {},
    showScope: Boolean = false,
    onClose: () -> Unit,
    /** M6b 阶段 2：AI 搜索开关/提交（见 TopBar 同名参数注释）。 */
    aiSearchEnabled: Boolean = false,
    onAiSearchToggle: () -> Unit = {},
    onAiSearchSubmit: (String) -> Unit = {},
    aiSearchBusy: Boolean = false,
    /** M6b 阶段 3：颜色过滤态（非 null = 胶囊内显示色点芯片，见 TopBar 同名参数注释）。 */
    colorSearchHex: String? = null,
    onClearColorSearch: () -> Unit = {},
    /** M6b 阶段 5：LAN 态回车提交（见 TopBar 同名参数）。 */
    onLanSearchSubmit: ((String) -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } } // 挂载竞态：BasicTextField 未及挂 modifier 时 requestFocus 会炸（实测崩溃 TopBar.kt:841），吞掉即可——用户点输入框仍能手动聚焦
    Row(
        modifier = Modifier
            // 平板横屏不撑满中栏，对齐 React 桌面搜索框的 `min(100%, 500px)` 封顶
            //（2026-09-17 用户反馈：横屏上搜索框太长）；窄屏下 fillMaxWidth 自然占满。
            .widthIn(max = 500.dp)
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .height(40.dp)
            .background(colors.surface, RoundedCornerShape(50))
            .border(1.dp, colors.subtle, RoundedCornerShape(50))
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // scope 下拉（M8b-14 用户拍板：改桌面 TopBar :968-999 同款图标钮——当前范围的
        // lucide 图标随 scope 切换（Globe/FileText/Tag/Folder）+小 chevron+右分隔线；
        // M4b 曾改「文字+chevron」求可读，现按用户要求回图标形制）。菜单项同桌面带各自
        // 图标；菜单**左对齐锚点**（alignToAnchorEnd=false，桌面 left-0 同款）——scope 钮
        // 在胶囊最左缘，默认右对齐公式（锚点右缘−192dp）在手机上算出负 x 会推出屏外。
        if (showScope) {
            var scopeAnchor by remember { mutableStateOf(Rect.Zero) }
            var scopeOpen by remember { mutableStateOf(false) }
            Box(Modifier.onGloballyPositioned { scopeAnchor = it.boundsInWindow() }) {
                Row(
                    Modifier
                        .height(40.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { scopeOpen = !scopeOpen }
                        .padding(horizontal = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = when (scope) {
                            SearchScope.ALL -> IconGlobe
                            SearchScope.FILE -> IconFileText
                            SearchScope.TAG -> IconTag
                            SearchScope.FOLDER -> IconFolder
                        },
                        contentDescription = "搜索范围",
                        tint = colors.textSecondary,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.size(4.dp))
                    Icon(
                        imageVector = ScopeIconChevronDown,
                        contentDescription = null,
                        tint = colors.textSecondary.copy(alpha = 0.7f),
                        modifier = Modifier.size(12.dp),
                    )
                }
                AuroraDropdown(
                    expanded = scopeOpen,
                    anchorBoundsInWindow = scopeAnchor,
                    alignToAnchorEnd = false,
                    onDismissRequest = { scopeOpen = false },
                ) {
                    SearchScope.entries.forEach { s ->
                        AuroraMenuItem(
                            text = scopeLabelOf(s),
                            leading = {
                                Icon(
                                    imageVector = when (s) {
                                        SearchScope.ALL -> IconGlobe
                                        SearchScope.FILE -> IconFileText
                                        SearchScope.TAG -> IconTag
                                        SearchScope.FOLDER -> IconFolder
                                    },
                                    contentDescription = null,
                                    tint = AuroraTheme.colors.textSecondary,
                                    modifier = Modifier.size(14.dp),
                                )
                            },
                            onClick = {
                                scopeOpen = false
                                onScopeChange(s)
                            },
                            checked = s == scope,
                        )
                    }
                }
            }
            // 桌面按钮的 border-r：scope 钮与搜索图标之间的竖分隔线
            Box(Modifier.size(1.dp, 18.dp).background(colors.subtle))
            Spacer(Modifier.size(8.dp))
        }
        Icon(
            imageVector = IconSearch,
            contentDescription = null,
            tint = colors.textSecondary,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.size(8.dp))
        BasicTextField(
            value = query,
            onValueChange = onQueryChange,
            singleLine = true,
            // 撑满胶囊剩余宽（React 桌面搜索 input 的 flex-1 同旨）：无宽度约束时只包住
            // 占位文字宽——平板上图标/AI/X 全挤在输入旁、手机竖屏输入区只剩占位一条
            // （2026-09-27 用户报障，平板+竖屏同此根因）
            modifier = Modifier.weight(1f),
            textStyle = TextStyle(color = colors.textPrimary, fontSize = 14.sp),
            cursorBrush = SolidColor(colors.primary),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            // M6b 阶段 2：AI 模式下回车=提交改写（一次 HTTP），不是逐字过滤——
            // 自然语言查询做 name 子串匹配只会错杀，命中集由 VM 全量替换
            keyboardActions = KeyboardActions(
                // M6b 阶段 5：LAN 态回车走 onLanSearchSubmit（文件名/CLIP 分流在 VM）；
                // 本地态维持 AI 开=提交改写、关=逐字文本过滤
                onSearch = {
                    when {
                        onLanSearchSubmit != null -> onLanSearchSubmit?.invoke(query)
                        aiSearchEnabled -> onAiSearchSubmit(query)
                    }
                },
            ),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) {
                        Text(placeholder, color = colors.textSecondary, fontSize = 14.sp)
                    }
                    inner()
                }
            },
        )
        Spacer(Modifier.size(8.dp))
        // M6b 阶段 3：颜色过滤态芯片（桌面 ColorPickerPopover 选中色的胶囊内同位）：
        // 色点 + X，整颗可点 = 清除颜色过滤（onClearColorSearch，宿主复位网格）。
        // 芯片边框/圆点都用选中色本身；宿主传入异常 hex 时圆点退化为透明（不崩）。
        if (colorSearchHex != null) {
            val chipColor = remember(colorSearchHex) {
                runCatching { Color(android.graphics.Color.parseColor(colorSearchHex)) }
                    .getOrDefault(Color.Transparent)
            }
            Box(
                Modifier
                    .clip(CircleShape)
                    .border(1.dp, chipColor, CircleShape)
                    .clickable(onClick = onClearColorSearch)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(12.dp)
                            .clip(CircleShape)
                            .background(chipColor),
                    )
                    Spacer(Modifier.size(4.dp))
                    Text("X", fontSize = 12.sp, color = colors.textSecondary)
                }
            }
            Spacer(Modifier.size(8.dp))
        }
        // M6b 阶段 2：AI 开关芯片（「AI」文字款，桌面紫色图标的触屏同位——图标库无
        // sparkle 字形，文字更可读）。开=回车提交 core 改写，关=普通文本搜索。
        Box(
            Modifier
                .clip(CircleShape)
                .background(if (aiSearchEnabled) colors.primary else Color.Transparent)
                .border(1.dp, if (aiSearchEnabled) colors.primary else colors.subtle, CircleShape)
                .clickable(onClick = onAiSearchToggle)
                .padding(horizontal = 8.dp, vertical = 3.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "AI",
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                color = if (aiSearchEnabled) colors.surface else colors.textSecondary,
            )
        }
        Spacer(Modifier.size(8.dp))
        Box(
            Modifier
                .size(28.dp)
                .clip(CircleShape)
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = IconX,
                contentDescription = "关闭搜索",
                tint = colors.textSecondary,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/** scope 下拉的选项文案（zh，与 React `translations.ts` 的 `search.scope*` 同串）。 */
private fun scopeLabelOf(scope: SearchScope): String = when (scope) {
    SearchScope.ALL -> "搜索全部"
    SearchScope.FILE -> "文件名"
    SearchScope.TAG -> "标签"
    SearchScope.FOLDER -> "文件夹"
}

/** scope 按钮的 chevron（lucide chevron-down，本文件就近自绘一份）。 */
private val ScopeIconChevronDown: ImageVector by lazy {
    ImageVector.Builder(
        name = "ScopeChevronDown",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        ) {
            moveTo(6f, 9f)
            lineTo(12f, 15f)
            lineTo(18f, 9f)
        }
    }.build()
}

/** lucide file-text：文件页 + 折角 + 两行文字（scope=文件名；桌面 TopBar getScopeIcon 同款）。 */
private val IconFileText: ImageVector by lazy {
    auroraIcon("FileText") {
        moveTo(15f, 2f)
        lineTo(6f, 2f)
        arcTo(2f, 2f, 0f, false, false, 4f, 4f)
        lineTo(4f, 20f)
        arcTo(2f, 2f, 0f, false, false, 6f, 22f)
        lineTo(18f, 22f)
        arcTo(2f, 2f, 0f, false, false, 20f, 20f)
        lineTo(20f, 7f)
        close()
        // 折角
        moveTo(14f, 2f)
        lineTo(14f, 6f)
        arcTo(2f, 2f, 0f, false, false, 16f, 8f)
        lineTo(20f, 8f)
        // 文字行
        moveTo(16f, 13f)
        lineTo(8f, 13f)
        moveTo(16f, 17f)
        lineTo(8f, 17f)
        moveTo(10f, 9f)
        lineTo(8f, 9f)
    }
}

/** lucide folder：档案夹（scope=文件夹；与 TreeSidebar 同 path，本文件就近自绘一份）。 */
private val IconFolder: ImageVector by lazy {
    auroraIcon("Folder") {
        moveTo(20f, 20f)
        arcTo(2f, 2f, 0f, false, false, 22f, 18f)
        lineTo(22f, 8f)
        arcTo(2f, 2f, 0f, false, false, 20f, 6f)
        lineTo(12.1f, 6f)
        arcTo(2f, 2f, 0f, false, true, 10.41f, 5.1f)
        lineTo(9.6f, 3.9f)
        arcTo(2f, 2f, 0f, false, false, 7.93f, 3f)
        lineTo(4f, 3f)
        arcTo(2f, 2f, 0f, false, false, 2f, 5f)
        lineTo(2f, 18f)
        arcTo(2f, 2f, 0f, false, false, 4f, 20f)
        close()
    }
}
