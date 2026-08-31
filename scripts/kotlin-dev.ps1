# Kotlin 版一键开发命令：编译安装 → 启动 app → 实时日志
# 对齐 React 版 `npm run tauri:android:dev:reuse` 的「一条命令」体验。
#
# 用法：
#   npm run kotlin:dev           # 编译(Kotlin) + 装 APK + 启动 + 实时日志
#   npm run kotlin:dev:so        # 同上，但先 cargo-ndk 重编 Rust so
#   npm run kotlin:dev -- -LogOnly   # 跳过编译，仅启动 + 看日志
param(
    [switch]$So,       # 先重编 Rust so（cargo-ndk, arm64-v8a）
    [switch]$LogOnly   # 跳过编译安装，仅启动 app + 看日志
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$kotlinDir = Join-Path $root "kotlin-app"
$coreDir = Join-Path $root "core"
$pkg = "com.aurora.gallery.kotlin"

# 1. 检测设备
Write-Host "[0/4] 检测设备..." -ForegroundColor Cyan
$deviceLines = @(adb devices | Select-String -Pattern "\tdevice$")
if ($deviceLines.Count -eq 0) {
    Write-Host "[!] 未检测到已连接设备。先跑 scripts/adb-connect.ps1 无线连接。" -ForegroundColor Red
    exit 1
}
$serial = ($deviceLines[0].ToString() -split "\s+")[0]
Write-Host "      设备: $serial" -ForegroundColor Green

if (-not $LogOnly) {
    # 2. 可选重编 Rust so
    if ($So) {
        Write-Host "[1/4] 重编 Rust so (arm64-v8a)..." -ForegroundColor Cyan
        $ndk = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\ndk" -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
        if (-not $ndk) {
            Write-Host "[!] 未找到 NDK（$env:LOCALAPPDATA\Android\Sdk\ndk）" -ForegroundColor Red
            exit 1
        }
        $env:ANDROID_NDK_HOME = $ndk.FullName
        Write-Host "      NDK: $($ndk.FullName)" -ForegroundColor Green
        Push-Location $coreDir
        try {
            cargo ndk -t arm64-v8a -o "$kotlinDir\app\src\main\jniLibs" build --release
            if ($LASTEXITCODE -ne 0) { throw "cargo ndk 失败" }
        } finally { Pop-Location }
    }

    # 3. 编译 + 安装
    Write-Host "[2/4] gradlew installDebug ..." -ForegroundColor Cyan
    Push-Location $kotlinDir
    try {
        .\gradlew.bat installDebug --console=plain
        if ($LASTEXITCODE -ne 0) { throw "installDebug 失败" }
    } finally { Pop-Location }
}

# 4. 启动 app
Write-Host "[3/4] 启动 app ..." -ForegroundColor Cyan
adb -s $serial shell am start -n "$pkg/.MainActivity" | Out-Null

# 5. 实时日志
Write-Host "[4/4] 实时日志（Ctrl+C 退出）" -ForegroundColor Cyan
Write-Host "      tag: AuroraKotlin(应用) / AndroidRuntime(崩溃)" -ForegroundColor Gray
adb -s $serial logcat -c
adb -s $serial logcat -s AuroraKotlin:V AndroidRuntime:E
