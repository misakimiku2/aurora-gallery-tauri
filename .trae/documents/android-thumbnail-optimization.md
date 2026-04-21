# 安卓端缩略图优化计划

## 问题分析

### 问题 1：大量红色 \[Thumbnail] 控制台报错

* **根因**：`tauri-bridge.ts` 中 Android 分支的所有日志使用了 `console.error()` 而非 `console.log()`

* **位置**：[tauri-bridge.ts:512-528](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/api/tauri-bridge.ts#L512-L528)

### 问题 2：缩略图显示锯齿严重——根因分析

**关键观察**：图片尺寸越大，锯齿越多；图片尺寸越小，锯齿反而不明显。桌面端同样使用 256px 最小边缩略图，效果却很好。

**根因：Android 端缩略图生成策略与桌面端完全不同**

| 对比项     | 桌面端 (`thumbnail.rs`)                    | 安卓端 (`android/thumbnail.rs`)                       |
| ------- | --------------------------------------- | -------------------------------------------------- |
| 主要生成方式  | `fast_image_resize` (Hamming 滤波)        | `ContentResolver.loadThumbnail()` (Android 系统 API) |
| 缩放库     | `fast_image_resize` v3.0 (NEON SIMD 加速) | `image` crate `Lanczos3` (纯 Rust，无 SIMD)           |
| JPEG 优化 | `JpegDecoder::scale()` 渐进解码             | 无，全量解码                                             |
| 结果一致性   | 所有图片质量一致                                | 不同设备/图片尺寸质量差异大                                     |

**核心问题**：安卓端优先使用 `ContentResolver.loadThumbnail()` 系统 API，该 API 质量取决于设备厂商实现，大图缩小比例越高锯齿越明显。而文件解码回退路径使用 `image` crate 的 `Lanczos3`，虽然质量尚可但远不如桌面端的 `fast_image_resize`（有 ARM NEON SIMD 加速，速度更快质量更好）。

## 修改计划

### 步骤 1：修复 Android 分支日志级别（前端）

**文件**：`src/api/tauri-bridge.ts`

* 第 512 行 `console.error('[Thumbnail] Android invoke:...')` → `console.log(...)`

* 第 517 行 `console.error('[Thumbnail] Android result:...')` → `console.log(...)`

* 第 520 行 `console.error('[Thumbnail] Android convertFileSrc:...')` → `console.log(...)`

* 第 524 行 `console.error('[Thumbnail] Android: thumbnailPath is null...')` → `console.warn(...)`

* 保留第 528 行 `console.error('[Thumbnail] Android error:...')` 为 error（真正的错误）

### 步骤 2：重写 `android/thumbnail.rs` 的缩放逻辑，使用 `fast_image_resize`

**文件**：`src-tauri/src/android/thumbnail.rs`

参照桌面端 `thumbnail.rs` 的实现，将 `resize_image()` 函数从 `image` crate 的 `Lanczos3` 替换为 `fast_image_resize` + Hamming 滤波：

```rust
// 修改前（当前代码）：
fn resize_image(img: &DynamicImage, target_size: u32) -> DynamicImage {
    let resized = img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3);
    DynamicImage::ImageRgb8(resized.to_rgb8())
}

// 修改后（与桌面端一致）：
fn resize_image(img: &DynamicImage, target_size: u32) -> DynamicImage {
    let src_image = fr::Image::from_vec_u8(
        src_width, src_height, img.to_rgb8().into_raw(), fr::PixelType::U8x3
    ).unwrap();
    let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
    let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
    resizer.resize(&src_image.view(), &mut dst_image.view_mut()).unwrap();
    DynamicImage::ImageRgb8(image::ImageBuffer::from_raw(dst_width, dst_height, dst_image.buffer().to_vec()).unwrap())
}
```

同时处理 RGBA 图片（带 Alpha 通道），与桌面端逻辑一致。

### 步骤 3：为 Android 文件解码路径添加 JPEG 渐进解码优化

**文件**：`src-tauri/src/android/thumbnail.rs`

参照桌面端 `thumbnail.rs:92-97`，修改 `load_image()` 函数，对 JPEG 文件使用 `JpegDecoder::scale()` 渐进解码：

```rust
// 修改前（当前代码）：全量解码
fn load_image(path: &Path) -> Result<DynamicImage, String> {
    let mut image_reader = image::io::Reader::new(BufReader::new(File::open(path)?));
    image_reader = image_reader.with_guessed_format()?;
    image_reader.decode()
}

// 修改后（与桌面端一致）：JPEG 渐进解码
fn load_image(path: &Path) -> Result<DynamicImage, String> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut buffer = [0u8; 4096];
    // 先读取前 4096 字节判断格式
    let format = image::guess_format(&buffer[..bytes_read]);
    
    if format == Some(ImageFormat::Jpeg) {
        let mut decoder = JpegDecoder::new(BufReader::new(File::open(path)?))?;
        decoder.scale(THUMBNAIL_SIZE, THUMBNAIL_SIZE)?;
        DynamicImage::from_decoder(decoder)
    } else {
        // 非 JPEG 格式，全量解码
        let mut image_reader = image::io::Reader::new(BufReader::new(File::open(path)?));
        image_reader = image_reader.with_guessed_format()?;
        image_reader.decode()
    }
}
```

### 步骤 4：反转 Android 缩略图生成优先级

**文件**：`src-tauri/src/lib.rs`

当前逻辑：`image_id` 存在时，**优先**使用 `ContentResolver.loadThumbnail()`，失败才回退到文件解码。

修改为：**优先使用文件解码**（`fast_image_resize` + Hamming），仅在文件解码失败时才回退到系统缩略图。

```rust
// 修改后：文件解码优先
if let Some(id) = image_id {
    let result = tauri::async_runtime::spawn_blocking(move || {
        // 优先使用文件解码（fast_image_resize + Hamming）
        match android_generate_thumbnail(&file_path_clone, &cache_path) {
            Ok(r) if r.thumbnail_path.is_some() => Ok(r),
            _ => {
                // 文件解码失败，回退到系统缩略图
                let activity = ndk_context::android_context();
                let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }?;
                let mut env = vm.attach_current_thread()?;
                let activity_obj = unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };
                match get_android_system_thumbnail(&mut env, &activity_obj, id, &cache_path) {
                    Ok(Some(thumb_path)) => Ok(ThumbnailResult { ... }),
                    _ => Err("All thumbnail methods failed".to_string()),
                }
            }
        }
    }).await;
}
```

### 步骤 5：提升 JPEG 编码质量

**文件**：`src-tauri/src/android/thumbnail.rs`

* 将 `JPEG_QUALITY` 从 `80` 改为 `90`

### 步骤 6：更新缓存文件名格式，避免旧缓存干扰

**文件**：`src-tauri/src/android/thumbnail.rs`

* 系统缩略图缓存文件名从 `sys_{imageId}.jpg` 改为 `sys_{imageId}_q90.jpg`

* 文件解码缩略图的缓存键中加入质量参数，确保旧 80 质量缓存不会被误用

### 步骤 7：验证桌面端缩略图逻辑未被影响

* 确认 `src-tauri/src/thumbnail.rs`（桌面端）未被修改

* 确认 `tauri-bridge.ts` 中桌面端分支（ThumbnailBatcher 等）未被修改

## 不修改的部分

* **桌面端缩略图生成逻辑**：`src-tauri/src/thumbnail.rs` 不做任何改动

* **桌面端批量请求逻辑**：`ThumbnailBatcher` 类不做改动

* **前端渲染组件**：`ImageThumbnail.tsx` 不做改动

* **缩略图尺寸**：保持 256px 最小边不变（与桌面端一致）

## 预期效果

1. 控制台不再有大量红色 \[Thumbnail] 报错
2. Android 端缩略图使用 `fast_image_resize` + Hamming 滤波（与桌面端一致），ARM NEON SIMD 加速
3. JPEG 渐进解码优化确保大图解码性能不下降
4. JPEG 质量从 80 提升到 90
5. 大图和小图的缩略图质量保持一致，不再出现"大图锯齿多"的问题

