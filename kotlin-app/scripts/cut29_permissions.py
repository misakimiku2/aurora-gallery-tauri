# -*- coding: utf-8 -*-
"""拆分清单第 29 刀：MainActivity 权限/欢迎向导助手簇 -> MainActivityPermissions.kt
5 个扩展函数全 internal；notificationPermission / requestPermission 两字段降权留原类。"""
import re, sys

SRC = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
DST = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivityPermissions.kt"

raw = open(SRC, "rb").read()
assert not raw.startswith(b"\xef\xbb\xbf")
text = raw.decode("utf-8")
assert "\r\n" in text and "\n" not in text.replace("\r\n", "")
lines = text.split("\r\n")
N = len(lines)

ALL = ["requestNotificationPermissionIfNeeded", "mediaPermission", "hasMediaPermission",
       "requestMediaPermissionIfNeeded", "openAppDetailsSettings"]
END_NEXT_BLANK = {"mediaPermission", "hasMediaPermission"}
IMPORTS = [
    "import android.Manifest",
    "import android.content.pm.PackageManager",
    "import android.os.Build",
    "import android.util.Log",
    "import android.widget.Toast",
]

def find_one(pat, desc, lo=0):
    hits = [i for i, ln in enumerate(lines) if i >= lo and re.search(pat, ln)]
    assert hits, f"anchor {desc}: 0 hits"
    return hits[0]

def brace_end(start):
    depth = 0
    seen = False
    for i in range(start, N):
        s = re.sub(r'//.*', '', lines[i])
        s = re.sub(r'"(?:\\.|[^"\\])*"', '""', s)
        s = re.sub(r"'(?:\\.|[^'\\])*'", "''", s)
        depth += s.count('{') - s.count('}')
        if depth > 0:
            seen = True
        if seen and depth == 0:
            return i
    raise AssertionError("no brace end from %d" % start)

def kdoc_start(defi):
    j = defi - 1
    if j < 0 or not lines[j].rstrip().endswith("*/"):
        return defi
    while j >= 0 and not lines[j].lstrip().startswith("/**"):
        j -= 1
    return j if j >= 0 else defi

units = []
for name in ALL:
    d = find_one(r'^    private fun %s\(' % re.escape(name), name)
    if name in END_NEXT_BLANK:
        e = next(i for i in range(d, N) if lines[i].strip() == "") - 1
    else:
        e = brace_end(d)
    units.append((kdoc_start(d), e, name))
units.sort(key=lambda u: u[0])
assert [u[2] for u in units] == ALL, [u[2] for u in units]

spans = []
for s, e, nm in units:
    if spans and all(lines[k].strip() == "" for k in range(spans[-1][1] + 2, s)):
        spans[-1][1] = e
    else:
        spans.append([s, e])
for sp in spans:
    s, e = sp
    if lines[s - 1].strip() == "" and e + 1 < N and lines[e + 1].strip() == "":
        sp[1] = e + 1
print("spans:", [(a + 1, b + 1) for a, b in spans])

body_parts = []
for si, (s, e) in enumerate(spans):
    part = []
    for ln in lines[s:e + 1]:
        part.append(ln[4:] if ln.startswith("    ") else ln)
    if si:
        body_parts.append([])
    body_parts.append(part)
body_lines = [l for part in body_parts for l in part]
for name in ALL:
    pat = "private fun %s(" % name
    hits = [i for i, ln in enumerate(body_lines) if pat in ln]
    assert len(hits) == 1, (name, len(hits))
    i = hits[0]
    body_lines[i] = body_lines[i].replace(pat, "internal fun MainActivity.%s(" % name, 1)
body = "\r\n".join(body_lines)
for name in ALL:
    assert body.count("internal fun MainActivity.%s(" % name) == 1, name
    assert ("private fun %s(" % name) not in body, name
for imp in IMPORTS:
    leaf = imp.split(".")[-1]
    assert re.search(r'\b' + re.escape(leaf) + r'\b', body), f"import leaf unused: {leaf}"

header = [
    "package com.aurora.gallery.kotlin",
    "",
] + IMPORTS + [
    "",
    "// 权限/欢迎向导助手簇（拆分清单第 29 刀，⑥ 第 4 刀）：媒体读权限口径（mediaPermission，",
    "// 与 GalleryViewModel.hasMediaPermission 同式）+ 通知权限补请求 + requestMediaPermissionIfNeeded",
    "// 授权链（READ → WRITE 补请求 → 通知）+ 欢迎向导「去系统设置」兜底，5 个扩展函数落地",
    "// （§5.1 手法，接收者 MainActivity，全 internal——setContent 欢迎流程与 requestPermission",
    "// 回调等留守区消费）。",
    "// requestPermission / notificationPermission 两个 registerForActivityResult 字段留原类，",
    "// 随本刀降 internal。",
    "",
]
new_file = "\r\n".join(header + body_lines) + "\r\n"

kill = set()
for s, e in spans:
    kill.update(range(s, e + 1))
out = [ln for i, ln in enumerate(lines) if i not in kill]

FIELDS = [
    "    private val requestPermission = registerForActivityResult(",
    "    private val notificationPermission = registerForActivityResult(",
]
NOTE = "    // 已拆到 MainActivityPermissions.kt（拆分清单第 29 刀）：跨文件访问需 internal"
for old in FIELDS:
    hits = [i for i, ln in enumerate(out) if ln == old]
    assert len(hits) == 1, (old, len(hits))
    i = hits[0]
    out[i] = old.replace("private ", "internal ", 1)
    out.insert(i, NOTE)

open(DST, "wb").write(new_file.encode("utf-8"))
open(SRC, "wb").write(("\r\n".join(out)).encode("utf-8"))

src2 = open(SRC, "rb").read().decode("utf-8")
dst2 = open(DST, "rb").read().decode("utf-8")
ok = True
for name in ALL:
    n_src = len(re.findall(r"fun %s\(" % name, src2))
    n_dst = len(re.findall(r"fun MainActivity\.%s\(" % name, dst2))
    print(f"{name}: src def={n_src}(0) dst def={n_dst}(1)")
    ok &= n_src == 0 and n_dst == 1
for f in ["requestPermission", "notificationPermission"]:
    assert len(re.findall(r"internal val %s" % f, src2)) == 1, f
print("src lines:", len(src2.split("\r\n")), " dst lines:", len(dst2.split("\r\n")))
print("OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
