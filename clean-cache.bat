@echo off
REM 清理项目测试缓存

echo Cleaning build caches...
echo.

REM 清理 log 目录
if exist "log" (
    rd /s /q "log"
    echo [OK] Removed log directory
)

REM 清理 .vite 目录
if exist ".vite" (
    rd /s /q ".vite"
    echo [OK] Removed root .vite cache
)

REM 清理 node_modules 中的 .vite 缓存
if exist "node_modules\.vite" (
    rd /s /q "node_modules\.vite"
    echo [OK] Removed Vite cache in node_modules
)

REM 清理 src-tauri 中的 target 目录（Rust 构建缓存）
if exist "src-tauri\target" (
    rd /s /q "src-tauri\target"
    echo [OK] Removed Rust build target directory
)

REM 清理 .trae 目录（Trae AI 缓存）
if exist ".trae" (
    rd /s /q ".trae"
    echo [OK] Removed Trae AI cache directory
)

REM 确保 dist 目录存在，但不复制 index.html
if not exist "dist" (
    mkdir "dist"
    echo [OK] Created empty dist directory to satisfy Tauri configuration
)

echo.
echo Cache cleanup complete!
echo Please restart the dev server with: npm run tauri:dev

pause