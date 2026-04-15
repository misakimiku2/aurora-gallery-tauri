# Android 编译 OpenSSL 错误修复计划

## 问题分析

### 错误原因
项目使用 `reqwest` 库进行 HTTP 请求，该库默认使用 `native-tls` 作为 TLS 后端。`native-tls` 在 Android 平台上需要 OpenSSL 库，但：
1. Windows 系统上没有预装为 Android 交叉编译的 OpenSSL
2. 配置 Android OpenSSL 交叉编译环境非常复杂

### 依赖链
```
reqwest → native-tls → openssl-sys → 需要 OpenSSL 库
```

## 解决方案

使用 `rustls` 替代 `native-tls`。`rustls` 是纯 Rust 实现的 TLS 库，不依赖系统 OpenSSL，天然支持交叉编译。

## 实施步骤

### 步骤 1: 修改 Cargo.toml - 切换 reqwest 到 rustls

修改 `src-tauri/Cargo.toml` 中的 reqwest 依赖配置：

```toml
# 修改前
reqwest = { version = "0.12", features = ["json", "stream"] }

# 修改后
reqwest = { version = "0.12", features = ["json", "stream", "rustls-tls"], default-features = false }
```

关键点：
- 添加 `rustls-tls` feature 启用 rustls 后端
- 添加 `default-features = false` 禁用默认的 native-tls

### 步骤 2: 添加 rustls 相关依赖（可选但推荐）

为 Android 平台添加 rustls 依赖配置：

```toml
# Android 特定依赖
[target.'cfg(target_os = "android")'.dependencies]
jni = "0.21"
ndk = "0.8"
ndk-sys = "0.5"
# 确保 Android 使用 rustls
rustls = "0.23"
webpki-roots = "0.26"
```

### 步骤 3: 清理并重新编译

执行以下命令清理缓存并重新编译：

```powershell
# 清理之前的编译缓存
cd src-tauri
cargo clean

# 重新编译 Android
cd ..
npx tauri android dev
```

## 验证步骤

1. 运行 `npx tauri android dev` 确认编译通过
2. 在 Android 设备上测试应用功能
3. 特别测试网络相关功能（如果有）

## 潜在影响

- **正面影响**: 编译更简单，不需要配置 OpenSSL
- **兼容性**: rustls 与 native-tls API 兼容，代码无需修改
- **性能**: rustls 性能通常优于 OpenSSL
- **安全**: rustls 是内存安全的 Rust 实现

## 备选方案

如果 rustls 方案有问题，可以考虑：

1. **使用 vendored OpenSSL**: 让 openssl-sys 自动编译 OpenSSL
   ```toml
   openssl = { version = "0.10", features = ["vendored"] }
   ```
   但这会增加编译时间和复杂度

2. **条件编译**: 为 Android 使用不同的 HTTP 客户端
   ```toml
   [target.'cfg(target_os = "android")'.dependencies]
   reqwest = { version = "0.12", features = ["json", "stream", "rustls-tls"], default-features = false }
   
   [target.'cfg(not(target_os = "android"))'.dependencies]
   reqwest = { version = "0.12", features = ["json", "stream"] }
   ```

## 推荐方案

推荐使用 **步骤 1** 的简单方案，统一使用 rustls 作为 TLS 后端，这样可以：
- 简化依赖管理
- 所有平台使用相同的 TLS 实现
- 避免交叉编译问题
