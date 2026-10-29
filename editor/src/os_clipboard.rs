//! OS 剪贴板位图桥(上游 app 壳 services.rs 的 arboard 落地方式):
//! 引擎的 session 剪贴板与 OS 无关;桥层把复制结果镜像成 RGBA8 位图,
//! 粘贴前显式读回(上游口径:只在此刻读——隐私与 CPU)。
//! 契约与上游一致:`Ok(None)`=剪贴板没图;`Err`/panic=读不到但**不得作废内部拷贝**。

use arboard::{Clipboard, ImageData};

/// 写一张 RGBA8(straight alpha)位图进系统剪贴板;成功与否由调用方决定是否记录签名。
/// arboard 在个别内容上会 panic(#7582 同款),一律 catch_unwind 不让桥崩应用。
pub fn set_image(w: u32, h: u32, px: &[u8]) -> bool {
    if w == 0 || h == 0 || px.len() != w as usize * h as usize * 4 {
        return false;
    }
    std::panic::catch_unwind(|| {
        let mut cb = Clipboard::new().ok()?;
        cb.set_image(ImageData { width: w as usize, height: h as usize, bytes: px.into() }).ok()?;
        Some(())
    })
    .ok()
    .flatten()
    .is_some()
}

/// 读一张 RGBA8 位图;`None` = 没图或读失败(两种情况调用方都保留内部拷贝)。
pub fn get_image() -> Option<(u32, u32, Vec<u8>)> {
    std::panic::catch_unwind(|| {
        let mut cb = Clipboard::new().ok()?;
        let img = cb.get_image().ok()?;
        let (w, h) = (img.width as u32, img.height as u32);
        let bytes = img.bytes.into_owned();
        Some((w, h, bytes))
    })
    .ok()
    .flatten()
    .filter(|(w, h, bytes)| *w > 0 && *h > 0 && bytes.len() == *w as usize * *h as usize * 4)
}

/// 最近镜像/导入图像的签名(w/h + 每 997 字节采样哈希):识别"OS 里是我们自己放的图",
/// 粘贴时据此跳过导入、保住 session 剪贴板里的源位置/整层信息。只需内部自洽,无需与上游一致。
pub fn signature(w: u32, h: u32, bytes: &[u8]) -> u64 {
    let mut hash: u64 = ((w as u64) << 32) | h as u64;
    for (n, b) in bytes.iter().enumerate() {
        if n % 997 == 0 {
            hash = hash.wrapping_mul(0x100000001b3).wrapping_add(*b as u64);
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_separates_sizes_and_contents() {
        let a = vec![1u8; 64];
        let b = vec![2u8; 64];
        assert_ne!(signature(4, 4, &a), signature(4, 4, &b));
        assert_ne!(signature(2, 8, &a), signature(4, 4, &a));
        assert_eq!(signature(4, 4, &a), signature(4, 4, &a.clone()));
    }

    #[test]
    fn set_image_rejects_bad_shapes() {
        assert!(!set_image(0, 0, &[]));
        assert!(!set_image(2, 2, &[0; 3]));
        // 合法形状的真写剪贴板不做单测(会污染用户剪贴板),冒烟在真机做
    }
}
