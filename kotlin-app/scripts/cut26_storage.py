# -*- coding: utf-8 -*-
"""拆分清单第 26 刀：MainActivity 缓存清理+备份导出/导入簇 -> MainActivityStorage.kt
内容锚点定位；按字节写 CRLF、无 BOM。"""
import re, sys

SRC = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
DST = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivityStorage.kt"

raw = open(SRC, "rb").read()
assert not raw.startswith(b"\xef\xbb\xbf"), "BOM?"
text = raw.decode("utf-8")
assert "\r\n" in text and "\n" not in text.replace("\r\n", ""), "not pure CRLF"
lines = text.split("\r\n")  # 0-based; lines[i] == 1-based line i+1

def find(pred, desc):
    hits = [i for i, ln in enumerate(lines) if pred(ln)]
    assert len(hits) == 1, f"anchor {desc}: {len(hits)} hits"
    return hits[0]

a1 = find(lambda l: l.startswith("    // —— M4b 2.3 设置面板：缓存清理 + 备份导出/导入 ——"), "secA")
a2 = find(lambda l: l.startswith("    /** 备份导入（2.3）"), "kdoc-launcher")
b1 = find(lambda l: l.startswith("    private fun importBackupFrom(uri: Uri) {"), "importBackupFrom")
b2 = find(lambda l: l.startswith("    // —— M4b 1.4/1.3 复制/移动/重命名的宿主执行"), "secB")
assert a1 < a2 < b1 < b2, (a1, a2, b1, b2)
# 段 A：分节注释行 .. KDoc 前一行（含尾随空行）；段 B：importBackupFrom .. secB 前一行
segA = lines[a1:a2]          # 542..574（含 574 空行）
segB = lines[b1:b2]          # 582..742（不含 743 分节注释）
# 边界断言
assert lines[a2 - 1] == "", "segA must end with blank"
assert "private fun computeCacheSizeText" in "\n".join(segA)
assert "private fun clearCache" in "\n".join(segA)
assert lines[b1 - 1] == "", "blank before importBackupFrom"
assert "private fun exportBackup" in "\n".join(segB)
assert lines[b2].startswith("    // —— M4b 1.4/1.3"), "secB follows directly"

def dedent(seg):
    out = []
    for ln in seg:
        if ln.startswith("    "):
            out.append(ln[4:])
        else:
            assert ln == "", f"unexpected non-blank short line: {ln!r}"
            out.append(ln)
    return out

bodyA = dedent(segA)
bodyB = dedent(segB)

# 签名改写：直接改列表元素（改完的同一份列表用于落盘——第 24 刀的教训）
for name in ["computeCacheSizeText", "clearCache", "importBackupFrom", "exportBackup"]:
    pat = "private fun %s(" % name
    hits = [i for i, ln in enumerate(bodyA + bodyB) if pat in ln]
    assert len(hits) == 1, (name, len(hits))
    i = hits[0]
    tgt = bodyA if i < len(bodyA) else bodyB
    j = i if i < len(bodyA) else i - len(bodyA)
    tgt[j] = tgt[j].replace(pat, "internal fun MainActivity.%s(" % name, 1)
# 改写后断言：4 个新签名都在、旧签名绝迹
joined = "\r\n".join(bodyA + bodyB)
for name in ["computeCacheSizeText", "clearCache", "importBackupFrom", "exportBackup"]:
    assert joined.count("internal fun MainActivity.%s(" % name) == 1, name
    assert "private fun %s(" % name not in joined, name

# 段内残留的分节注释（segA 第一行）提为文件头的一部分，正文中不再重复
first_line = bodyA[0]
assert "M4b 2.3" in first_line
sec_text = first_line.strip()[3:]  # —— M4b 2.3 …（去掉「// 」前缀）
restA = bodyA[2:]  # 跳过分节注释行与其后的空行

header = [
    "package com.aurora.gallery.kotlin",
    "",
    "import android.net.Uri",
    "import android.os.Build",
    "import android.util.Log",
    "import android.widget.Toast",
    "import androidx.lifecycle.lifecycleScope",
    "import org.json.JSONObject",
    "",
    "// 缓存清理 + 备份导出/导入簇（拆分清单第 26 刀，⑥ 第 1 刀）：设置面板存储 Section 的",
    "// 宿主侧取数与写操作——缓存体积统计/清理、备份 JSON 导出（MediaStore Downloads）与",
    "// 导入（SAF 选文件 → 词表/人物/专题按 id 去重合并），4 个扩展函数落地（§5.1 手法，",
    "// 接收者 MainActivity；原分节注释「" + sec_text + "」随簇迁移）。",
    "// importBackupLauncher（registerForActivityResult 字段）不能搬（字段无法落在扩展上），",
    "// 留在原类、经 internal 扩展 importBackupFrom 回流；viewModel 字段随本刀降 internal。",
    "",
]
new_file = "\r\n".join(header + restA + bodyB) + "\r\n"

# ---- 原文件：删两段 + viewModel 降 internal ----
out = lines[:a1] + lines[a2:b1] + lines[b2:]
vm = find(lambda l: l == "    private val viewModel: GalleryViewModel by viewModels {", "viewModel")
out[vm] = "    internal val viewModel: GalleryViewModel by viewModels {"
kdoc_end = vm - 1
assert out[kdoc_end].strip() == "*/", out[kdoc_end]
out.insert(kdoc_end + 1, "    // 已拆到 MainActivityStorage.kt 等同包扩展文件（拆分清单 ⑥）：跨文件访问需 internal")

# ---- 落盘（先写新文件，后写原文件）----
open(DST, "wb").write(new_file.encode("utf-8"))
open(SRC, "wb").write(("\r\n".join(out)).encode("utf-8"))

# ---- 静态查重 ----
src2 = open(SRC, "rb").read().decode("utf-8")
dst2 = open(DST, "rb").read().decode("utf-8")
ok = True
for name in ["computeCacheSizeText", "clearCache", "importBackupFrom", "exportBackup"]:
    n_def_src = len(re.findall(r"fun %s\(" % name, src2))
    n_def_dst = len(re.findall(r"fun MainActivity\.%s\(" % name, dst2))
    n_ref_src = len(re.findall(r"\b%s\(" % name, src2))
    print(f"{name}: src def={n_def_src} (expect 0)  dst def={n_def_dst} (expect 1)  src callsites={n_ref_src}")
    ok &= n_def_src == 0 and n_def_dst == 1
print("src lines:", src2.count("\r\n") + 1, " dst lines:", dst2.count("\r\n") + 1)
print("OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
