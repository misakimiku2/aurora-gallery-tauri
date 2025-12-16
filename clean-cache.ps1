# 清理项目测试缓存
Write-Host 'Cleaning build caches...'
Write-Host ''

# 定义要清理的目录列表
$directoriesToClean = @('dist', 'log', '.vite', 'node_modules/.vite', 'src-tauri/target', '.trae')

# 遍历目录列表并清理每个目录
foreach ($dir in $directoriesToClean) {
    if (Test-Path $dir) {
        Remove-Item -Recurse -Force $dir
        Write-Host "[OK] Removed $dir"
    }
}

Write-Host ''
Write-Host 'Cache cleanup complete!'
Write-Host 'Please restart the dev server with: npm run tauri:dev'