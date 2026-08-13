param(
  # 同时删除 src-tauri/target（Rust 编译缓存），下次构建将全量重编，慎用
  [switch]$RemoveTarget
)

$ErrorActionPreference = 'SilentlyContinue'

Write-Host 'Cleaning build caches & ports...'
Write-Host ''

# 释放开发端口
Get-NetTCPConnection -LocalPort 14422 -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host '[OK] Released port 14422'
}

# 删除日志目录
if (Test-Path 'log') {
  Remove-Item -Recurse -Force 'log' -ErrorAction SilentlyContinue
  Write-Host '[OK] Removed log directory'
}

# 删除旧的 dist 并创建重定向占位页（浏览器直接打开时指向 dev server）
if (Test-Path 'dist') {
  Remove-Item -Recurse -Force 'dist' -ErrorAction SilentlyContinue
  Write-Host '[OK] Removed old dist directory'
}
New-Item -ItemType Directory -Path 'dist' -Force | Out-Null
$redirectHtml = @'
<!DOCTYPE html><html><head><meta http-equiv="refresh" content="1;url=http://localhost:14422"><style>body{background:#1a1a1a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif}</style></head><body><div style="text-align:center"><h2>Starting Aurora Gallery...</h2><p>Connecting to dev server...</p><script>setInterval(()=>{fetch("http://localhost:14422").then(r=>{if(r.ok)window.location.href="http://localhost:14422"}).catch(()=>{})},500)</script></div></body></html>
'@
Set-Content -Path 'dist/index.html' -Value $redirectHtml -Encoding UTF8
Write-Host '[OK] Created dist directory with redirect fail-safe'

# 可选：删除 Rust 编译缓存（触发全量重编，仅显式请求时执行）
if ($RemoveTarget) {
  if (Test-Path 'src-tauri/target') {
    Remove-Item -Recurse -Force 'src-tauri/target' -ErrorAction SilentlyContinue
    Write-Host '[OK] Removed Rust build target directory'
  }
}

Write-Host ''
Write-Host 'Cleanup complete!'
