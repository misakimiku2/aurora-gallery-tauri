import { androidApkDownloadUrl } from '../api/tauri-bridge/updater';

/**
 * 双端下载页（update/android.json homepage 主源；安卓 APK 与桌面安装包同仓发布）。
 * 安卓端同源常量见 `kotlin-app/.../WelcomeFlow.kt`（跨语言无法共享，改链接要两处一起改）。
 */
export const ANDROID_DOWNLOAD_PAGE_URL = 'https://gitee.com/misakimiku2/aurora_gallery/releases';

/**
 * 二维码外链（qrserver）。[size] 是**请求分辨率**而非显示尺寸：显示 144~160px 在高分屏上
 * 需要 ~2x 的位图，故按 400px 请求，避免放大发虚影响扫描成功率。
 */
export const qrImageUrl = (text: string, size = 400): string =>
    `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;

/**
 * 扫码落点：优先当前版本安卓 APK 直链（后端读发布清单，发版即更新，比把版本号写死耐用）；
 * 非 Tauri 环境 / 离线 / 清单异常时回退发行页。**不抛错**，调用方无需处理异常分支。
 */
export const resolveAndroidDownloadUrl = async (): Promise<string> => {
    try {
        const url = await androidApkDownloadUrl();
        return url?.trim() ? url : ANDROID_DOWNLOAD_PAGE_URL;
    } catch {
        return ANDROID_DOWNLOAD_PAGE_URL;
    }
};
