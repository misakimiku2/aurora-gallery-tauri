import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { getPinyinGroup } from "../textUtils";

/**
 * M4a 1.3：证明「同一份输入，Rust 与桌面 TS 得到同一个标签分组」，**零容差**。
 *
 * 输入不是合成数据：`test/fixtures/tag-input.json` 由桌面真库
 * `~/Pictures/.aurora/metadata.db`（644 行元数据、530 行带标签）导出，再补上清单点名的
 * 边界（空标签、重名、只贴在文件上、只在词表里、纯 ASCII / 纯数字 / 中英混排 / 多音字）。
 *
 * Rust 侧每次都现编现跑（`cargo run --example`），不落一份会过期的 golden 文件；编译不过
 * 就是一次失败，不会静默放过。
 *
 * 分组一律走**数组**而不是对象：JS 的 `Object.keys()` 会把 "0"…"9" 这类整数样键提到最前，
 * 用对象传就测不到 Rust 排好的组顺序了（这条是本用例最初假通过的直接原因）。
 */

// vitest 的工作目录恒是仓库根（jsdom 下 import.meta.url 不是 file: 协议）
const ROOT = process.cwd();
const INPUT: { vocabulary: string[]; files: [string, string[]][] } = JSON.parse(
  readFileSync(`${ROOT}/test/fixtures/tag-input.json`, "utf8")
);

type Groups = { key: string; tags: string[] }[];

/** `App.tsx:1263` 的 `groupedTags`，去掉 React 外壳、输入换成本夹具、输出换成有序数组。 */
function tsGroupedTags(locale: string, searchQuery = ""): Groups {
  const allTags = new Set<string>(INPUT.vocabulary);
  INPUT.files.forEach(([, tags]) => tags.forEach((t) => allTags.add(t)));
  const filtered = [...allTags].filter(
    (t) => !searchQuery || t.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const groups: Record<string, string[]> = {};
  filtered.forEach((tag) => {
    const key = getPinyinGroup(tag);
    (groups[key] ||= []).push(tag);
  });
  return Object.keys(groups)
    .sort()
    .map((key) => ({ key, tags: groups[key].sort((a, b) => a.localeCompare(b, locale)) }));
}

function tsCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of new Set([...INPUT.vocabulary, ...INPUT.files.flatMap(([, tags]) => tags)])) counts[t] = 0;
  for (const [, tags] of INPUT.files) for (const t of new Set(tags)) counts[t] += 1;
  return counts;
}

function rust(locale: string): { groups: Groups; counts: Record<string, number> } {
  const out = execFileSync(
    "cargo",
    ["run", "--quiet", "--example", "grouped_tags_dump", "--", `${ROOT}/test/fixtures/tag-input.json`, locale],
    { cwd: `${ROOT}/core`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

describe("M4a 1.3 标签分组一致性", () => {
  const rustZh = rust("zh");

  it("组顺序、组成员、组内顺序逐项一致（locale=zh）", () => {
    expect(rustZh.groups).toEqual(tsGroupedTags("zh"));
  });

  it("逐标签计数一致", () => {
    expect(rustZh.counts).toEqual(tsCounts());
  });

  /** 判据第 1 档：`#` 与数字键的相对位置，正是 `Object.keys` 会悄悄改掉的那一段。 */
  it("组名是码位升序：# 在数字前、数字在字母前", () => {
    const keys = rustZh.groups.map((g) => g.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys.indexOf("#")).toBeLessThan(keys.indexOf("0"));
    expect(keys.indexOf("9")).toBeLessThan(keys.indexOf("A"));
  });

  /** 大小写同词必须由夹具提供（A 组里真有 alpha/Alpha），不能靠词表里蒙来的其它标签。 */
  it("组内不是码位序：alpha 排在 Alpha 前面", () => {
    expect(rustZh.counts["alpha"]).toBeDefined();
    expect(rustZh.counts["Alpha"]).toBeDefined();
    const a = rustZh.groups.find((g) => g.key === "A")?.tags ?? [];
    expect(a).toEqual([...a].sort((x, y) => x.localeCompare(y, "zh")));
    // 码位序会把 "Alpha"(A=65) 排到 "alpha"(a=97) 前面，localeCompare 不会
    expect(a.indexOf("alpha")).toBeLessThan(a.indexOf("Alpha"));
  });

  it("夹具真的带了多音字与中英混排（防夹具退化让上面的断言空转）", () => {
    const flat = rustZh.groups.flatMap((g) => g.tags);
    expect(flat).toContain("重庆");
    expect(flat).toContain("长沙");
    expect(flat).toContain("AI照片");
  });

  /**
   * 分组算法对空标签没有分歧：`getPinyinGroup("")` 与 Rust 的 `group_key` 都给 `#`。
   * 真正的差异在**写入归一**——Rust 入库前 trim 并丢弃空白标签，React 不会；那条由
   * `core/src/db/tags.rs` 的 `duplicates_and_blanks_are_dropped` 与
   * `every_entry_point_trims_the_same_way` 钉住，不在本对照里比。
   */
  it("空标签两边同落 # 组（算法层无差异）", () => {
    const hash = rustZh.groups.find((g) => g.key === "#")?.tags ?? [];
    expect(hash).toContain("");
    expect(hash).toContain("   ");
    expect(tsGroupedTags("zh").find((g) => g.key === "#")?.tags).toContain("");
  });

  it("只在词表里的词计数 0 且仍出行；只贴在文件上的词也出行", () => {
    const counts = rustZh.counts;
    expect(counts["只在词表里的零计数词"]).toBe(0);
    expect(counts["只贴在文件上"]).toBe(1);
    const flat = rustZh.groups.flatMap((g) => g.tags);
    expect(flat).toContain("只在词表里的零计数词");
  });

  /**
   * 判据第 3 档：`locale=en` 时含汉字标签的组内次序可能不同（icu4x 带 CLDR 48.2 /
   * ICU 78.1，对照侧 Node 是 ICU 77.1；桌面 WebView / 安卓 System WebView / Node 三个壳
   * 各用一个 ICU 版本，追平没有意义）。**组名与分组成员必须仍然一致**，只放宽容差到次序。
   * M4a 的 Kotlin 端没有语言开关、恒传 zh，本档当前不可达。
   */
  it("locale=en：分组结构必须一致，组内次序记为已知容差", () => {
    const rustEn = rust("en");
    const tsEn = tsGroupedTags("en");
    expect(rustEn.groups.map((g) => g.key)).toEqual(tsEn.map((g) => g.key));
    for (const [i, g] of rustEn.groups.entries()) {
      expect([...g.tags].sort(), `组 ${g.key} 的成员`).toEqual([...tsEn[i].tags].sort());
    }
  });

  it("标签搜索留在 UI 侧：同一份输入换个 query 不该过一次 FFI", () => {
    const filtered = tsGroupedTags("zh", "风景");
    const fromRust = rustZh.groups
      .map((g) => ({ key: g.key, tags: g.tags.filter((t) => t.toLowerCase().includes("风景")) }))
      .filter((g) => g.tags.length);
    expect(fromRust).toEqual(filtered);
  });
});
