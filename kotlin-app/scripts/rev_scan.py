import re
p = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
lines = open(p, encoding="utf-8").read().split("\n")

# backup cluster: 544..747. Members defined there:
names = ["computeCacheSizeText", "dirSize", "clearCache", "importBackupFrom", "exportBackup"]
ranges = [(544, 747)]
in_seg = set()
for a, b in ranges:
    in_seg.update(range(a, b + 1))

print("--- refs to backup members OUTSIDE the cluster (in whole repo) ---")
import subprocess
for nm in names:
    # inside MainActivity outside cluster
    for i, ln in enumerate(lines):
        if (i + 1) in in_seg:
            continue
        if re.search(r'\b' + nm + r'\b', ln):
            print(f"  MainActivity {i+1}: {ln.strip()[:100]}")
    out = subprocess.run(
        ["grep", "-rn", "--include=*.kt", r"\b" + nm + r"\b",
         "app/src/main/java", "app/src/test/java"],
        capture_output=True, text=True)
    for l in out.stdout.split("\n"):
        if l and "MainActivity.kt" not in l:
            print(f"  REPO {l[:120]}")
print()
print("--- method-reference forms (::) inside cluster for external privates ---")
seg = "\n".join("\n".join(lines[a-1:b]) for a, b in ranges)
for m in re.finditer(r'::\w+', seg):
    print("  ", m.group(0))
