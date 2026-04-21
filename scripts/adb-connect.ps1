# 智能 ADB 无线调试连接脚本
# 自动检测并连接 Android 设备，无需手动输入 IP 和端口

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ADB Wireless Debug - Auto Connect" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 查找已配对的无线调试设备
Write-Host "[1] Scanning for wireless devices..." -ForegroundColor Yellow
$pairingOutput = adb pair 2>&1
Write-Host ""

# 显示当前所有设备（包括已连接的）
Write-Host "[2] Current device status:" -ForegroundColor Yellow
adb devices
Write-Host ""

# 如果已有设备连接，显示详情
$connectedDevices = adb devices | Where-Object { $_ -match "device$" -and $_ -notmatch "List" }
if ($connectedDevices.Count -gt 0) {
    Write-Host "[OK] Found $($connectedDevices.Count) connected device(s):" -ForegroundColor Green
    foreach ($device in $connectedDevices) {
        $deviceId = ($device -split '\s+')[0]
        Write-Host "  - $deviceId" -ForegroundColor Cyan
    }
    Write-Host ""
    
    # 使用第一个连接的设备
    $firstDevice = ($connectedDevices[0] -split '\s+')[0]
    Write-Host "[3] Testing logcat on $firstDevice..." -ForegroundColor Yellow
    adb -s $firstDevice logcat -t 3
    Write-Host ""
    
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Ready! Use this command to view logs:" -ForegroundColor Green
    Write-Host "  adb -s $firstDevice logcat" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Green
} else {
    Write-Host "[!] No devices connected." -ForegroundColor Red
    Write-Host ""
    Write-Host "To connect:" -ForegroundColor Yellow
    Write-Host "1. On your phone: Settings > Developer Options > Wireless debugging" -ForegroundColor White
    Write-Host "2. Tap 'Pair device with pairing code'" -ForegroundColor White
    Write-Host "3. Run: adb pair 192.168.31.202:39071" -ForegroundColor Cyan
    Write-Host "   (Replace with your phone's IP and port)" -ForegroundColor White
    Write-Host ""
}
