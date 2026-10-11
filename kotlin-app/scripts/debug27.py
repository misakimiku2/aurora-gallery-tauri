import re
p = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
text = open(p, encoding="utf-8").read()
print("CRLF count:", text.count("\r\n"), " bare LF:", len(text.replace("\r\n", "").split("\n")) - 1)
lines = text.split("\r\n")
print("elements:", len(lines))
for nm in ["hasAllFilesAccess", "savePendingOp", "pendingDeleteRetry"]:
    hits = [i + 1 for i, l in enumerate(lines) if re.match(r'^    (private|internal) (fun|val|var) %s\b' % nm, l)]
    print(nm, "->", hits)
for i in [219, 415, 416, 417, 418, 436, 437, 438]:
    if i < len(lines):
        print(i + 1, repr(lines[i][:64]))
