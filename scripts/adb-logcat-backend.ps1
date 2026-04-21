# 查看 Rust 后端日志

$ErrorActionPreference = "SilentlyContinue"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Aurora Gallery - Rust Backend Log Viewer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$rawDevices = adb devices
$deviceList = @()

foreach ($line in $rawDevices) {
    if ($line -match "^(\S+)\s+device$") {
        $deviceList += $Matches[1]
    }
}

if ($deviceList.Count -eq 0) {
    Write-Host "[!] No devices connected!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please enable wireless debugging on your phone and run this script again." -ForegroundColor Yellow
    exit 1
}

$selectedDevice = ""

if ($deviceList.Count -eq 1) {
    $selectedDevice = $deviceList[0]
    $devInfo = "Connected device: " + $selectedDevice
    Write-Host "[OK] $devInfo" -ForegroundColor Green
} else {
    Write-Host "[!] Multiple devices detected:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $deviceList.Count; $i++) {
        $idxStr = "  [" + $i + "] " + $deviceList[$i]
        Write-Host $idxStr -ForegroundColor Cyan
    }
    Write-Host ""

    foreach ($dev in $deviceList) {
        if ($dev -match "_adb-tls") {
            $selectedDevice = $dev
            $selInfo = "Auto-selected: " + $selectedDevice
            Write-Host "[OK] $selInfo" -ForegroundColor Green
            break
        }
    }

    if ($selectedDevice -eq "") {
        $selectedDevice = $deviceList[0]
        $firstInfo = "Using first device: " + $selectedDevice
        Write-Host "[OK] $firstInfo" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "[1] Getting app PID..." -ForegroundColor Yellow

$pidResult = adb -s $selectedDevice shell pidof com.aurora.gallery
$appPid = $pidResult.Trim()

if ($appPid -ne "" -and $appPid -notmatch "error") {
    $pidInfo = "App PID: " + $appPid
    Write-Host "[OK] $pidInfo" -ForegroundColor Green
    Write-Host ""
    Write-Host "[2] Clearing old logs..." -ForegroundColor Yellow
    adb -s $selectedDevice logcat -c

    Write-Host ""
    Write-Host "[3] Starting Rust backend log viewer..." -ForegroundColor Yellow
    Write-Host "    Source: aurora_gallery_lib (Verbose+)" -ForegroundColor Gray
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Watching Rust backend logs..." -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""

    adb -s $selectedDevice logcat --pid=$appPid -s "aurora_gallery_lib:V"
} else {
    Write-Host "[!] App is not running. Showing all Rust logs..." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "[1] Clearing old logs..." -ForegroundColor Yellow
    adb -s $selectedDevice logcat -c

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Watching Rust logs (app not running)..." -ForegroundColor Green
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""

    adb -s $selectedDevice logcat -s "aurora_gallery_lib:V" "rust:V"
}
