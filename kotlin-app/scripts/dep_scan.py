import re, sys
p = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
lines = open(p, encoding="utf-8").read().split("\n")
n = len(lines)

# --- ranges (1-based inclusive) of candidate clusters ---
clusters = {
    "backup":   [(544, 747)],
    "fileops":  [(342, 531), (748, 826), (2227, 2281)],
    "theme":    [(1364, 1531)],
    "viewer":   [(827, 1290)],
    "lan":      [(241, 298)],
    "welcome":  [(2341, 2394)],
}

def seg_text(ranges):
    out = []
    for a, b in ranges:
        out.append("\n".join(lines[a-1:b]))
    return "\n".join(out)

# private member definitions outside the cluster (class-level, 4-space indent incl lateinit)
PRIV = re.compile(r'^\s{4}(?:lateinit )?private (?:val|var|fun|suspend fun|const val) (\w+)')
defs = []  # (name, line, text)
for i, ln in enumerate(lines):
    m = PRIV.match(ln)
    if m:
        defs.append((m.group(1), i + 1, ln.strip()))

# companion consts
COMP = re.compile(r'^\s{8}private (?:const val|val) (\w+)')

for cname, ranges in clusters.items():
    seg = seg_text(ranges)
    in_seg = set()
    for a, b in ranges:
        in_seg.update(range(a, b + 1))
    print(f"=== {cname}  lines {ranges} ===")
    hits = []
    for name, ln, txt in defs:
        if ln in in_seg:
            continue
        if re.search(r'\b' + re.escape(name) + r'\b', seg):
            hits.append((ln, txt))
    for ln, txt in hits:
        print(f"  DOWN? {ln}: {txt}")
    print(f"  total external-private refs: {len(hits)}")
    print()
