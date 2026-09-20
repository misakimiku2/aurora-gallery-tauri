#!/system/bin/sh
# 设备端滚帧探针：在侧栏找到指定文件夹 → 进入 → 采 gfxinfo/meminfo → 返回 → 再进再采。
# 第 1 轮 = 冷（缩略图无磁盘缓存），第 2 轮 = 热（应命中缓存）。跑前请先清缓存：
#   adb shell run-as com.aurora.gallery.kotlin rm -rf cache/thumbnails
# 用法（本机执行，注意 Git Bash 要 MSYS_NO_PATHCONV=1）：
#   adb push scripts/android-scroll-probe.sh /data/local/tmp/
#   adb shell "monkey -p com.aurora.gallery.kotlin -c android.intent.category.LAUNCHER 1"
#   adb shell "sh /data/local/tmp/android-scroll-probe.sh 'Pure Media Vol.0230' 12"
# 只用日志/gfxinfo/meminfo 取证，不截图——内容敏感的文件夹也适用。
PKG=com.aurora.gallery.kotlin
NAME="$1"
FLINGS="${2:-12}"

find_and_tap() {
  i=0
  while [ $i -lt 16 ]; do
    i=$((i+1))
    uiautomator dump /sdcard/t.xml >/dev/null 2>&1
    cat /sdcard/t.xml | tr '<' '\n' > /sdcard/n.txt
    L=$(grep -n "text=\"$NAME" /sdcard/n.txt | head -1 | cut -d: -f1)
    if [ -n "$L" ]; then
      B=$(head -n "$L" /sdcard/n.txt | tail -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -oE '[0-9]+')
      X1=$(echo "$B" | sed -n 1p); Y1=$(echo "$B" | sed -n 2p); X2=$(echo "$B" | sed -n 3p); Y2=$(echo "$B" | sed -n 4p)
      if [ -n "$X2" ]; then
        input tap $(( (X1+X2)/2 )) $(( (Y1+Y2)/2 ))
        echo "TAPPED $X1 $Y1 $X2 $Y2"
        return 0
      fi
    fi
    input swipe 270 1000 270 400 200
    sleep 1
  done
  echo "NOT_FOUND $NAME"
  return 1
}

measure() {
  echo "----- $1 -----"
  sleep 4
  dumpsys gfxinfo $PKG reset >/dev/null
  logcat -c
  i=0
  while [ $i -lt "$FLINGS" ]; do
    i=$((i+1))
    input swipe 1600 1500 1600 250 80
  done
  sleep 1
  dumpsys gfxinfo $PKG | grep -E "Total frames rendered|Janky frames:|50th percentile|90th percentile|99th percentile|Missed Vsync|50th gpu|99th gpu"
  dumpsys meminfo $PKG | grep -E "Native Heap|Dalvik Heap|Gfx dev|EGL mtrack|GL mtrack|TOTAL PSS"
  echo "慢解码 [Thumb] 条数 = $(logcat -d -s AuroraKotlin | grep -c Thumb)"
  logcat -d -s AuroraKotlin | grep Thumb | tail -3
}

find_and_tap && measure "第 1 轮（冷）"
input keyevent KEYCODE_BACK
sleep 2
find_and_tap && measure "第 2 轮（热）"
