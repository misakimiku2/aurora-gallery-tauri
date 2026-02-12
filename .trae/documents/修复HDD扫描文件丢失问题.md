## 问题根因

1. **`par_bridge()` 绕过串行设置**：即使设置了 `jwalk::Parallelism::Serial`，`.par_bridge()` 又启用了 rayon 并行处理
2. **HDD检测不可靠**：检测逻辑依赖目录下的小文件读取，可能失败
3. **通道发送错误被忽略**：`let _ = tx.send(item)` 可能导致数据丢失

## 修复方案

### 1. 移除 `par_bridge()` 的并行处理（关键修复）
- 将 `.into_iter().par_bridge().filter_map(...).for_each()` 改为 `.into_iter().filter_map(...).for_each()`
- 这样 jwalk 的 `Parallelism::Serial` 才能真正生效

### 2. 统一HDD检测逻辑
- 只检测一次HDD，将结果传递给生产者线程
- 避免两次检测可能结果不一致

### 3. 处理通道发送错误
- 将 `let _ = tx.send(item)` 改为显式处理错误
- 如果发送失败，输出错误日志

### 4. 添加更多诊断日志
- 记录生产者线程实际遍历到的文件数量
- 帮助确认问题是否在生产者端

## 修改文件
- `src-tauri/src/main.rs`

## 测试方法
1. 在HDD上首次扫描大目录
2. 观察日志确认使用串行扫描
3. 验证所有文件都被正确扫描