import re, sys
p = r"app/src/main/java/com/aurora/gallery/kotlin/MainActivity.kt"
lines = open(p, encoding="utf-8").read().split("\n")
depth = 0
decls = []
FUN = re.compile(r'^(\s*)(?:private |internal |public |override |@Composable\s*)*(?:suspend )?fun (\w+)')
CLS = re.compile(r'^(\s*)(?:private |internal )?(?:data )?(?:enum )?(?:class|object) (\w+)')
for i, ln in enumerate(lines):
    m = FUN.match(ln)
    mc = CLS.match(ln)
    if m and depth <= 2:
        decls.append((i + 1, depth, "fun", m.group(2)))
    if mc and depth <= 1:
        decls.append((i + 1, depth, "cls", mc.group(2)))
    s = re.sub(r'//.*', '', ln)
    s = re.sub(r'"(?:\\.|[^"\\])*"', '""', s)
    s = re.sub(r"'(?:\\.|[^'\\])*'", "''", s)
    depth += s.count('{') - s.count('}')
print("total lines:", len(lines))
prev = None
for idx, (ln, d, kind, name) in enumerate(decls):
    end = decls[idx + 1][0] - 1 if idx + 1 < len(decls) else len(lines)
    print(f"{ln:>5} .. {end:>5}  ({end-ln:>4})  depth={d}  {kind} {name}")
