package com.aurora.gallery.kotlin.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aurora.gallery.kotlin.LanPerson
import com.aurora.gallery.kotlin.ThumbnailLoader
import com.aurora.gallery.kotlin.ui.theme.AuroraTheme
import uniffi.aurora_core.FfiFaceBox
import uniffi.aurora_core.FfiPerson

/**
 * 人物总览的**卡片层**（本地卡 / 远端卡 / 圆形头像位 / 网络角标）。
 *
 * 2026-10-09 从 `TagsOverview.kt` 拆出。两个卡组件是 `internal` 而非 `private`：
 * 它们被同包的 [PeopleOverview] 消费，跨文件后 private 不可见，但不应对 module 外开放
 * （宿主只需要 [PeopleOverview] 与 [PersonPickerDialog] 这几个入口）。
 */

/**
 * 本地人物卡：圆形真头像 + 名 + 计数。点击 = 进筛选视图，长按 = 编辑菜单。
 *
 * 头像取不到（没有封面 / 图已删 / 加载失败 / 没给 loader）时退回**首字符圆形占位**，
 * 即移植前的形态——占位不是错误态，是正常兜底。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun LocalPersonCard(
    person: FfiPerson,
    coverUri: String?,
    loader: ThumbnailLoader?,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDescribe: () -> Unit,
    onSetAvatar: () -> Unit,
    onDelete: () -> Unit,
) {
    val colors = AuroraTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    val avatar = rememberPersonAvatar(loader, coverUri, person.faceBox)
    Column(
        modifier = Modifier
            // fillMaxWidth 必须有：LazyGrid 的格子宽是定值，Column 不设就按最宽子项裹起
            // 来、贴在格子左边，名字短的人物卡看着就是歪的（LanPersonCard 同理）
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .onGloballyPositioned { anchor = it.boundsInWindow() }
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AuroraDropdown(
            expanded = menuOpen,
            anchorBoundsInWindow = anchor,
            onDismissRequest = { menuOpen = false },
        ) {
            AuroraMenuItem(
                text = "重命名",
                leading = {
                    Icon(
                        imageVector = IconPencil,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onRename()
                },
            )
            AuroraMenuItem(
                text = "改描述",
                leading = {
                    Icon(
                        imageVector = IconType,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onDescribe()
                },
            )
            AuroraMenuItem(
                text = "换头像",
                leading = {
                    Icon(
                        imageVector = IconImage,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onSetAvatar()
                },
            )
            AuroraMenuItem(
                text = "删除",
                textColor = Color(0xFFEF4444),
                leading = {
                    Icon(
                        imageVector = IconTrash2,
                        contentDescription = null,
                        tint = Color(0xFFEF4444),
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onDelete()
                },
            )
        }
        PersonCardAvatar(name = person.name, avatar = avatar)
        Text(
            text = person.name,
            fontSize = 15.sp,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            text = "${person.count} 张",
            fontSize = 12.sp,
            color = colors.textSecondary,
        )
    }
}

/**
 * 远端人物卡：与 [LocalPersonCard] **同一个形**（96dp 圆头像 + 名 + 张数），差别只有头像
 * 右下角那枚 [LanBadge] 网络角标——远端没有可用的人脸框（契约 §3.1），一律首字符占位。
 * 去节标题后两套数据混排在一个网格里，形制必须一致才不像两张清单拼起来。
 * 长按弹「重命名/改描述」；[lanAllowEdit] 直通时再加「换头像」（阶段 6，
 * 见 [PeopleOverview] 注释）。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun LanPersonCard(
    person: LanPerson,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDescribe: () -> Unit,
    lanAllowEdit: Boolean = false,
    onAvatarChange: () -> Unit = {},
) {
    val colors = AuroraTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(androidx.compose.ui.geometry.Rect.Zero) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onClick, onLongClick = { menuOpen = true })
            .onGloballyPositioned { anchor = it.boundsInWindow() }
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // 长按菜单：「重命名」「改描述」；「换头像」仅编辑门禁位直通时出现（阶段 6 起接
        // LanFolderPickerDialog 选远端图；403 门禁态不出现——M4a「不适用的项不出现」先例）
        AuroraDropdown(
            expanded = menuOpen,
            anchorBoundsInWindow = anchor,
            onDismissRequest = { menuOpen = false },
        ) {
            AuroraMenuItem(
                text = "重命名",
                leading = {
                    Icon(
                        imageVector = IconPencil,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onRename()
                },
            )
            AuroraMenuItem(
                text = "改描述",
                leading = {
                    Icon(
                        imageVector = IconType,
                        contentDescription = null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(16.dp),
                    )
                },
                onClick = {
                    menuOpen = false
                    onDescribe()
                },
            )
            if (lanAllowEdit) {
                AuroraMenuItem(
                    text = "换头像",
                    leading = {
                        Icon(
                            imageVector = IconImage,
                            contentDescription = null,
                            tint = colors.textSecondary,
                            modifier = Modifier.size(16.dp),
                        )
                    },
                    onClick = {
                        menuOpen = false
                        onAvatarChange()
                    },
                )
            }
        }
        PersonCardAvatar(
            name = person.name,
            avatar = null,
            badge = { LanBadge() },
        )
        Text(
            text = person.name,
            fontSize = 15.sp,
            color = colors.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            text = "${person.count} 张",
            fontSize = 12.sp,
            color = colors.textSecondary,
        )
    }
}

/**
 * 人物头像位图：contentUri → MediaStore id → [ThumbnailLoader.loadAvatar]。
 *
 * 裁切与取源都在加载器里（那边按 faceBox 从**降采样原图**裁方、缩到头像尺寸并缓存）——
 * 之前在这儿拿 512 的网格缩略图现裁，框只占 15% 时细节仅 80px，投到 96dp 就是糊的
 * （2026-10-08 反馈）。
 *
 * 同步读内存缓存做初值，LazyGrid 回收重进时不闪占位符——形制同 FoldersOverview 的封面加载。
 */
@Composable
private fun rememberPersonAvatar(
    loader: ThumbnailLoader?,
    coverUri: String?,
    faceBox: FfiFaceBox?,
): Bitmap? {
    if (loader == null || coverUri.isNullOrEmpty()) return null
    val imageId = remember(coverUri) { loader.extractImageId(coverUri) }
    var bitmap by remember(imageId, faceBox) {
        mutableStateOf(loader.peekAvatar(imageId, faceBox))
    }
    LaunchedEffect(imageId, faceBox) {
        bitmap = loader.loadAvatar(imageId, faceBox)
    }
    return bitmap
}

/**
 * 人物卡的圆头像位（96dp，本地/远端同一个形）：有封面时上按 faceBox 裁好的真头像，
 * 取不到图与远端人物一律走首字符占位。[badge] 叠在右下角、不参与圆形裁剪——
 * 远端人物用它标识网络来源，替代原先的「远端人物」文字节标题。
 */
@Composable
private fun PersonCardAvatar(
    name: String,
    avatar: Bitmap?,
    badge: (@Composable () -> Unit)? = null,
) {
    val colors = AuroraTheme.colors
    Box {
        Box(
            modifier = Modifier
                .size(96.dp)
                .clip(CircleShape)
                .background(colors.surface)
                .border(1.dp, colors.subtle, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (avatar != null) {
                Image(
                    bitmap = avatar.asImageBitmap(),
                    contentDescription = name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                Text(
                    text = name.take(1).ifEmpty { "?" },
                    fontSize = 32.sp,
                    fontWeight = FontWeight.Medium,
                    color = colors.primary,
                )
            }
        }
        if (badge != null) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(4.dp),
                contentAlignment = Alignment.Center,
            ) { badge() }
        }
    }
}

/**
 * 网络来源角标：翡翠绿圆片 + Wifi 字形（色值取自侧栏远端 Section 的 SECTION_EMERALD，
 * 与侧栏远端行的 12dp Wifi 前缀同一套标识）。外圈描内容底色，压在照片上才不会糊成一团。
 */
@Composable
private fun LanBadge() {
    val colors = AuroraTheme.colors
    Box(
        Modifier
            .size(22.dp)
            .clip(CircleShape)
            .background(SECTION_EMERALD)
            .border(1.5.dp, colors.content, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = IconWifi,
            contentDescription = "网络人物",
            tint = Color.White,
            modifier = Modifier.size(12.dp),
        )
    }
}
