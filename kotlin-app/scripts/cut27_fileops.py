# -*- coding: utf-8 -*-
"""拆分清单第 27 刀：MainActivity 文件操作宿主簇 -> MainActivityFileOps.kt
16 个成员函数（12 internal + 4 private）+ 2 段域注释；10 个字段降 internal 留原类。
内容锚点 + 花括号配平；断言新签名；按字节写 CRLF、无 BOM。"""
import re, sys

SRC = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
DST = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivityFileOps.kt"

raw = open(SRC, "rb").read()
assert not raw.startswith(b"\xef\xbb\xbf")
text = raw.decode("utf-8")
assert "\r\n" in text and "\n" not in text.replace("\r\n", "")
lines = text.split("\r\n")
N = len(lines)

INTERNAL = ["requestWritePermissionIfNeeded", "requestWriteAccess", "writeConsentFor",
            "hasAllFilesAccess", "consumePendingOp", "opJson", "dispatchPendingOp",
            "withResolvedUris", "performCopyMoveToFolder", "performCopyMoveToNewAlbum",
            "shareUris", "requestDelete"]
PRIVATE = ["savePendingOp", "clearPendingOp", "withMediaWriteConsent", "performCopyMove"]
ALL = INTERNAL + PRIVATE
# 无花括号表达式体（§7 第 18 条 ④ 老坑：花括号配平会一路吞到下一个 def）——
# 终止于下一条空行前
END_NEXT_BLANK = {"hasAllFilesAccess", "opJson"}

def find_one(pat, desc, lo=0):
    hits = [i for i, ln in enumerate(lines) if i >= lo and re.search(pat, ln)]
    assert len(hits) >= 1, f"anchor {desc}: 0 hits"
    return hits[0]

def brace_end(start):
    """从 start 行起花括号配平（深度>0 才算见过——签名默认值 `= {},` 的空 lambda
    深度不变，不得提前返回；剥字符串/行注释）。返回闭行下标（含）。"""
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
    """def 上方紧邻的 KDoc 起行（无空行间隔）；无则返回 defi。"""
    j = defi - 1
    if j < 0 or not lines[j].rstrip().endswith("*/"):
        return defi
    while j >= 0 and not lines[j].lstrip().startswith("/**"):
        j -= 1
    return j if j >= 0 else defi

units = []  # (start, end) 0-based 含
for name in ALL:
    d = find_one(r'^    private fun %s\(' % re.escape(name), name)
    if name in END_NEXT_BLANK:
        e = next(i for i in range(d, N) if lines[i].strip() == "") - 1
        assert e == d + 1, (name, d, e)
    else:
        e = brace_end(d)
    s = kdoc_start(d)
    units.append((s, e, name))

# 两段域注释块（随簇迁移）
c1s = find_one(r'^    // —— 2026-09-28 免弹窗终版', "sec-免弹窗")
c1e = find_one(r'^    /\*\* 已授予「所有文件访问」', "kdoc-hasAllFiles", c1s) - 2  # 注释块止于 KDoc 前的空行
units.append((c1s, c1e, "SEC-ALLFILES"))
c2s = find_one(r'^    // —— M4b 1\.4/1\.3 复制/移动/重命名的宿主执行', "sec-copymove")
c2e = find_one(r'^    /\*\* 复制/移动到既有相册', "kdoc-pcmfolder", c2s) - 2
units.append((c2s, c2e, "SEC-COPYMOVE"))

units.sort(key=lambda u: u[0])
# 语义断言：hasAllFilesAccess 紧跟 c1 之后
order = [u[2] for u in units]
assert order == ["requestWritePermissionIfNeeded", "requestWriteAccess", "writeConsentFor",
                 "SEC-ALLFILES", "hasAllFilesAccess", "savePendingOp", "consumePendingOp",
                 "clearPendingOp", "opJson", "withMediaWriteConsent", "dispatchPendingOp",
                 "withResolvedUris", "SEC-COPYMOVE", "performCopyMoveToFolder",
                 "performCopyMoveToNewAlbum", "performCopyMove", "shareUris", "requestDelete"], order

# 相邻单元之间仅空行的 gap 并入删除跨度
spans = []
for s, e, nm in units:
    if spans and all(lines[k].strip() == "" for k in range(spans[-1][1] + 2, s)):
        spans[-1][1] = e
    else:
        spans.append([s, e])
# 边界：前空行 + 后空行 → 吞掉后空行
for sp in spans:
    s, e = sp
    if lines[s - 1].strip() == "" and e + 1 < N and lines[e + 1].strip() == "":
        sp[1] = e + 1
print("spans:", [(a + 1, b + 1) for a, b in spans])

# ---- 新文件内容：逐跨度取行、去 4 空格缩进、签名改写 ----
body_parts = []
for si, (s, e) in enumerate(spans):
    seg = []
    for ln in lines[s:e + 1]:
        seg.append(ln[4:] if ln.startswith("    ") else ln)
    for i, ln in enumerate(seg):
        m = re.match(r'^private fun (\w+)\(', ln)
        if m and m.group(1) in ALL:
            vis = "internal" if m.group(1) in INTERNAL else "private"
            seg[i] = ln.replace("private fun %s(" % m.group(1),
                                "%s fun MainActivity.%s(" % (vis, m.group(1)), 1)
    if si:
        body_parts.append([])
    body_parts.append(seg)
body_lines = [l for part in body_parts for l in part]
body = "\r\n".join(body_lines)

# 断言：16 个新签名各 1 次、旧签名绝迹
for name in ALL:
    vis = "internal" if name in INTERNAL else "private"
    want = "%s fun MainActivity.%s(" % (vis, name)
    assert body.count(want) == 1, (name, body.count(want))
assert not re.search(r'^private fun \w+\(', body, re.M)

# ---- import 计算：原文件 import 池，叶符号在正文出现（\b）即收 ----
imports = [ln for ln in lines[:250] if ln.startswith("import ")]
used = []
for imp in imports:
    leaf = imp.split(" ")[1].split(".")[-1]
    if leaf == "*":
        continue
    if re.search(r'\b' + re.escape(leaf) + r'\b', body):
        used.append(imp)

header = [
    "package com.aurora.gallery.kotlin",
    "",
] + used + [
    "",
    "// 文件操作宿主执行簇（拆分清单第 27 刀，⑥ 第 2 刀）：M4b 1.1 批量授权（createWriteRequest /",
    "// WRITE 运行时权限 /「所有文件」免弹窗引导 + SP 待执行操作）+ M4b 1.4/1.3 复制/移动宿主执行",
    "// + 4.2 分享/删除，16 个扩展函数落地（§5.1 手法，接收者 MainActivity；12 internal +",
    "// 4 个仅簇内消费的 private：savePendingOp / clearPendingOp / withMediaWriteConsent / performCopyMove）。",
    "// 4 个 registerForActivityResult launcher 与 pendingWriteCallback / pendingDeleteRetry /",
    "// plainWriteConsent / mediaOpPrefs / allFilesGuideShown 字段留在原类（字段落不到扩展上），",
    "// 随本刀降 internal；viewModel 同。原「M4b 1.1 批量授权」分节注释随 launcher 字段留在原类。",
    "",
]
new_file = "\r\n".join(header + body_lines) + "\r\n"

# ---- 原文件：删跨度 + 10 字段降 internal ----
kill = set()
for s, e in spans:
    kill.update(range(s, e + 1))
out = [ln for i, ln in enumerate(lines) if i not in kill]

FIELDS = [
    ("    private var pendingDeleteRetry: (() -> Unit)? = null", False),
    ("    private val deleteLauncher = registerForActivityResult(", False),
    ("    private var pendingWriteCallback: (() -> Unit)? = null", False),
    ("    private val writeLauncher = registerForActivityResult(", False),
    ("    private val writePermissionLauncher = registerForActivityResult(", False),
    ("    private val writeStoragePermission = registerForActivityResult(", False),
    ("    private val plainWriteConsent: (List<Uri>, () -> Unit) -> Unit = { blocked, retry ->", False),
    ("    private val mediaOpPrefs by lazy { getSharedPreferences(\"aurora_media_write\", MODE_PRIVATE) }", False),
    ("    private var allFilesGuideShown = false", False),
]
NOTE = "    // 已拆到 MainActivityFileOps.kt（拆分清单第 27 刀）：跨文件访问需 internal"
for old, is_vm in FIELDS:
    hits = [i for i, ln in enumerate(out) if ln == old]
    assert len(hits) == 1, (old, len(hits))
    i = hits[0]
    out[i] = old.replace("private ", "internal ", 1)
    out.insert(i, NOTE)

open(DST, "wb").write(new_file.encode("utf-8"))
open(SRC, "wb").write(("\r\n".join(out)).encode("utf-8"))

# ---- 静态查重 ----
src2 = open(SRC, "rb").read().decode("utf-8")
dst2 = open(DST, "rb").read().decode("utf-8")
ok = True
for name in ALL:
    n_src = len(re.findall(r"fun %s\(" % name, src2))
    n_dst = len(re.findall(r"fun MainActivity\.%s\(" % name, dst2))
    n_call = len(re.findall(r"\b%s\(" % name, src2))
    print(f"{name}: src def={n_src}(0) dst def={n_dst}(1) src callsites={n_call}")
    ok &= n_src == 0 and n_dst == 1
for f in ["plainWriteConsent", "mediaOpPrefs", "allFilesGuideShown"]:
    assert ("internal" in src2 and f in src2)
print("src lines:", len(src2.split("\r\n")), " dst lines:", len(dst2.split("\r\n")))
print("OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
