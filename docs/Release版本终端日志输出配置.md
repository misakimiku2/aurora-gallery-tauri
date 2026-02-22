# Release 版本终端日志输出配置

## 问题描述
在测试 GPU 性能时，需要使用 release 版本运行程序，但 release 版本无法在终端看到日志输出信息。

## 问题原因
在 `src-tauri/src/main.rs` 文件的第一行有以下代码：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

这行代码的作用是：
- 在 **debug 模式**下：不生效，程序会显示控制台窗口
- 在 **release 模式**下：将 Windows 子系统设置为 `windows`，程序作为 GUI 应用运行，**不显示控制台窗口**

由于 release 版本没有控制台窗口，`tauri_plugin_log` 配置的 `Stdout` 输出目标无法显示任何内容。

## 解决方案

### 临时修改（用于调试）
将 `windows_subsystem` 从 `windows` 改为 `console`：

```rust
// 原代码：
// #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 修改为：
#![cfg_attr(not(debug_assertions), windows_subsystem = "console")]
```

修改后重新编译 release 版本：

```bash
npm run tauri build
```

编译完成后，在终端运行程序即可看到日志输出：

```powershell
& "src-tauri\target\release\aurora-gallery.exe"
```

### 运行方式
可以通过以下方式运行程序并查看日志：

1. **直接运行**：
   ```powershell
   & "src-tauri\target\release\aurora-gallery.exe"
   ```

2. **新窗口运行**：
   ```powershell
   Start-Process powershell -ArgumentList '-NoExit', '-Command', '& "src-tauri\target\release\aurora-gallery.exe"'
   ```

## 日志输出示例

启用控制台输出后，可以看到类似以下的日志信息：

```
CLIP model files ready: ViT-L-14
Attempting to enable DirectML Execution Provider...
DirectML Execution Provider enabled successfully!
CLIP model loaded successfully with GPU acceleration
encode_images_batch called with 100 images
Large batch (100), using GPU batch processing
Preprocessing 100 images using rayon (8 threads)...
Preprocessing completed in 1234ms (avg 12.34ms per image)
Creating input tensor with shape [100, 3, 224, 224]
Running ONNX inference...
ONNX inference completed in 567ms
```

## 注意事项

1. **测试完成后恢复**：正式发布前，务必将代码改回 `windows_subsystem = "windows"`，否则用户运行程序时会看到一个多余的控制台窗口。

2. **日志文件位置**：即使不修改代码，日志也会写入文件：
   - 路径：`%LOCALAPPDATA%\com.aurora.gallery\logs\Aurora Gallery.log`
   - 可以通过查看日志文件获取运行时信息

3. **编译前关闭程序**：重新编译前，确保已关闭正在运行的 aurora-gallery.exe 进程，否则编译会因文件被锁定而失败：
   ```powershell
   Stop-Process -Name "aurora-gallery" -Force
   ```

## 相关文件

- `src-tauri/src/main.rs` - 主程序入口，包含子系统配置
- `src-tauri/src/clip/model.rs` - CLIP 模型加载和推理日志
- `src-tauri/src/clip_commands.rs` - CLIP 命令处理日志

## 实现时间
2026-02-22
