# -*- coding: utf-8 -*-
"""拆分清单第 31 刀：MainActivity 查看器簇 -> MainActivityViewer.kt（⑥ 阶段一收官）
13 个扩展函数（2 internal + 11 private）；5 字段降权留原类；object 表达式 ×2 用 val host = this；
2 处 :: 方法引用改绑定形式；palette 两成员（留原类）降 internal。"""
import re, sys

SRC = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
DST = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivityViewer.kt"

raw = open(SRC, "rb").read()
assert not raw.startswith(b"\xef\xbb\xbf")
text = raw.decode("utf-8")
assert "\r\n" in text and "\n" not in text.replace("\r\n", "")
lines = text.split("\r\n")
N = len(lines)

INTERNAL = ["ensureViewer", "openViewerFromGrid"]
PRIVATE = ["contentWindowRect", "predictedViewerRect", "mountViewer", "armPendingOpenGuard",
           "disarmPendingOpenGuard", "closeViewerWithTransition", "closeViewerNow",
           "viewerListener", "folderTreeJson", "onViewerNewAlbum", "toastSoon"]
ALL = INTERNAL + PRIVATE
END_NEXT_BLANK = {"contentWindowRect"}
IMPORTS = [
    "import android.graphics.RectF",
    "import android.net.Uri",
    "import android.util.Log",
    "import android.view.View",
    "import android.view.ViewGroup",
    "import android.widget.ImageView",
    "import android.widget.Toast",
    "import androidx.activity.OnBackPressedCallback",
    "import com.aurora.gallery.kotlin.canvas.AddResult",
    "import com.aurora.gallery.kotlin.viewer.NativeGalleryView",
    "import org.json.JSONArray",
    "import org.json.JSONException",
    "import org.json.JSONObject",
    "import uniffi.aurora_core.Image",
]
# object 表达式内需要 host. 前缀的类成员（object 不继承扩展接收者，§7 第 8 条）
HOST_MEMBERS = ["closeViewerWithTransition", "closeViewerNow", "toastSoon", "folderTreeJson",
                "onViewerNewAlbum", "maybeAutoExtractPalette", "applyPaletteResult", "viewModel"]
GUARD_MEMBERS = ["viewerTransition", "disarmPendingOpenGuard"]
# 含 object 的函数：函数体开头插 val host = this；各自的前缀名单
OBJECT_FUNS = {"armPendingOpenGuard": GUARD_MEMBERS, "viewerListener": HOST_MEMBERS}

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
assert sorted(u[2] for u in units) == sorted(ALL), [u[2] for u in units]

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
# 5 个留守字段不得落在跨度内
for anchor in [r'private var viewer: NativeGalleryView\? = null',
               r'private val viewerTransition: ViewerTransition by lazy',
               r'private val viewerPhotoRectQuery = PhotoRectQuery\(\)',
               r'private var viewerEnterAnchor: Pair<String, RectF>\? = null',
               r'private var pendingOpenGuard: OnBackPressedCallback\? = null']:
    i = find_one(r'^    ' + anchor, anchor)
    assert not any(s <= i <= e for s, e in spans), f"field inside span: {anchor}"

# ---- 新文件 body：去缩进 + 签名改写 + object 前缀 ----
body_parts = []
span_of_fun = {}
for s, e, nm in units:
    for si, (a, b) in enumerate(spans):
        if a <= s <= b:
            span_of_fun[nm] = si
            break
seg_lines = {si: [] for si in range(len(spans))}
for s, e, nm in units:
    si = span_of_fun[nm]
    a, b = spans[si]
    for ln in lines[s:e + 1]:
        seg_lines[si].append((ln[4:] if ln.startswith("    ") else ln, nm))
for nm, si in span_of_fun.items():
    part = seg_lines[si]
    vis = "internal" if nm in INTERNAL else "private"
    pat = "private fun %s(" % nm
    hits = [i for i, (ln, owner) in enumerate(part) if owner == nm and pat in ln]
    assert len(hits) == 1, (nm, len(hits))
    i = hits[0]
    part[i] = (part[i][0].replace(pat, "%s fun MainActivity.%s(" % (vis, nm), 1), nm)

def is_comment(ln):
    t = ln.strip()
    return t.startswith("*") or t.startswith("/*") or t.startswith("//")

# object 处理：块体化 + 函数体开头插 val host = this（表达式体函数的 this 在 object
# 体内是 object 自己——必须先转块体让 host 落在函数作用域，§7 第 8 条）；object 体内成员加 host. 前缀
OBJECT_AS_BLOCK = {
    # 函数名: (def 行尾部替换, object 头行)
    "viewerListener": (
        (" = object : NativeGalleryView.Listener {",
         ": NativeGalleryView.Listener {|VAL|    return object : NativeGalleryView.Listener {"),
    ),
}
for nm, members in OBJECT_FUNS.items():
    si = span_of_fun[nm]
    part = seg_lines[si]
    idx = [i for i, (ln, owner) in enumerate(part) if owner == nm]
    start, end = idx[0], idx[-1]
    # 找 def 行（已改写签名）
    di = next(i for i in range(start, end + 1)
              if re.match(r'^\w+ fun MainActivity\.%s\(' % nm, part[i][0]))
    if nm in OBJECT_AS_BLOCK:
        old_tail, new_tail = OBJECT_AS_BLOCK[nm][0]
        assert old_tail in part[di][0], part[di][0]
        a, b = new_tail.split("|VAL|")
        part[di] = (part[di][0].replace(old_tail, a), nm)
        part.insert(di + 1, ("    val host = this", nm))
        part.insert(di + 2, (b, nm))
        end += 2
        # 函数收尾：object 闭行后补一个函数闭括号
        part.insert(end + 1, ("}", nm))
    else:
        part.insert(di + 1, ("    val host = this", nm))
        end += 1
    n_pref = 0
    for i in range(di + 2, end + 2 if nm in OBJECT_AS_BLOCK else end + 1):
        ln, owner = part[i]
        if is_comment(ln):
            continue
        new = ln
        for m in members:
            new = re.sub(r'(?<![\w.])\b%s\b' % m, 'host.' + m, new)
        new = new.replace("this@MainActivity", "host")
        if new != ln:
            n_pref += 1
        part[i] = (new, nm)
    print(f"object {nm}: {n_pref} lines prefixed")
    assert n_pref >= 2, nm

body_lines = []
for si in range(len(spans)):
    if si:
        body_lines.append("")
    body_lines.extend(l for l, _ in seg_lines[si])
body = "\r\n".join(body_lines)
for name in ALL:
    vis = "internal" if name in INTERNAL else "private"
    want = "%s fun MainActivity.%s(" % (vis, name)
    assert body.count(want) == 1, (name, body.count(want))
    assert ("private fun %s(" % name) not in body, name
assert "this@MainActivity" not in body, "unresolved label remains"
n_host_vm = body.count("host.viewModel")
n_host = body.count("this")  # 仅剩 val host = this 两处
assert body.count("val host = this") == 2
for imp in IMPORTS:
    leaf = imp.split(".")[-1]
    assert re.search(r'\b' + re.escape(leaf) + r'\b', body), f"import leaf unused: {leaf}"
print("host.viewModel refs:", n_host_vm)

header = [
    "package com.aurora.gallery.kotlin",
    "",
] + IMPORTS + [
    "",
    "// 查看器簇（拆分清单第 31 刀，⑥ 阶段一收官刀）：M3 查看器装配与进出过渡全链——实例",
    "// 单例（ensureViewer）、展开/收缩覆盖层四件（contentWindowRect / predictedViewerRect /",
    "// openViewerFromGrid / mountViewer）、展开窗口返回拦截（双守卫）、退出动画（",
    "// closeViewerWithTransition / closeViewerNow）、Listener 适配器（viewerListener，object",
    "// 表达式 → 查看器协议到宿主的唯一适配面）、FolderPicker 的 folderTreeJson / onViewerNewAlbum、",
    "// 占位 toastSoon——13 个扩展函数（2 internal：ensureViewer / openViewerFromGrid 被.setContent",
    "// 的绑定方法引用与 LaunchedEffect 消费；11 private 仅簇内）。",
    "// viewer / viewerTransition / viewerPhotoRectQuery / viewerEnterAnchor / pendingOpenGuard",
    "// 五个字段留原类降 internal；palette 两成员（maybeAutoExtractPalette / applyPaletteResult，",
    "// 留守）随本刀降 internal 供 Listener 回调；两处 :: 方法引用改 this:: 绑定形式。",
    "",
]
new_file = "\r\n".join(header + body_lines) + "\r\n"

# ---- 原文件：删跨度 + 字段/成员降权 + :: 引用改绑定 ----
kill = set()
for s, e in spans:
    kill.update(range(s, e + 1))
out = [ln for i, ln in enumerate(lines) if i not in kill]

FIELDS = [
    "    private var viewer: NativeGalleryView? = null",
    "    private val viewerTransition: ViewerTransition by lazy {",
    "    private val viewerPhotoRectQuery = PhotoRectQuery()",
    "    private var viewerEnterAnchor: Pair<String, RectF>? = null",
    "    private var pendingOpenGuard: OnBackPressedCallback? = null",
]
NOTE = "    // 已拆到 MainActivityViewer.kt（拆分清单第 31 刀）：跨文件访问需 internal"
for old in FIELDS:
    hits = [i for i, ln in enumerate(out) if ln == old]
    assert len(hits) == 1, (old, len(hits))
    i = hits[0]
    out[i] = old.replace("private ", "internal ", 1)
    out.insert(i, NOTE)

# palette 两成员留原类但被新文件 Listener 调用 → internal
PALETTE = ["    private fun maybeAutoExtractPalette(fileId: String) {",
           "    private fun applyPaletteResult(fileId: String, hexes: List<String>?, silent: Boolean) {"]
for old in PALETTE:
    hits = [i for i, ln in enumerate(out) if ln == old]
    assert len(hits) == 1, (old, len(hits))
    i = hits[0]
    out[i] = old.replace("private ", "internal ", 1)
    out.insert(i, NOTE)

# :: 方法引用 → 绑定形式（扩展函数不能用裸 :: 引用；setContent 里隔了 BoxScope 等
# 带接收者的 lambda，this 会绑错 —— 必须用 this@MainActivity 标签穿透）
REFS = [("                        onOpenViewer = ::openViewerFromGrid,",
         "                        onOpenViewer = this@MainActivity::openViewerFromGrid,"),
        ("                    viewerProvider = ::ensureViewer,",
         "                    viewerProvider = this@MainActivity::ensureViewer,")]
for old, new in REFS:
    hits = [i for i, ln in enumerate(out) if ln == old]
    assert len(hits) == 1, (old, len(hits))
    out[hits[0]] = new

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
for f in ["viewerTransition", "viewerPhotoRectQuery", "viewerEnterAnchor", "pendingOpenGuard"]:
    assert len(re.findall(r"internal (var|val) %s" % f, src2)) == 1, f
assert len(re.findall(r"internal var viewer: NativeGalleryView", src2)) == 1
assert len(re.findall(r"internal fun (maybeAutoExtractPalette|applyPaletteResult)", src2)) == 2
print("src lines:", len(src2.split("\r\n")), " dst lines:", len(dst2.split("\r\n")))
print("OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
