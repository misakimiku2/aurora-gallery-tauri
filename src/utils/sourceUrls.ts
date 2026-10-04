/**
 * 来源网址（P1(b)，设计方案 §4 W2：一张图可以有多个来源网址）。
 *
 * 库里 `file_metadata.source_url` 存的是 **JSON 数组文本**；Rust 侧读出来会同时给
 * `sourceUrls`（数组）和 `sourceUrl`（第一条，留着给老读者）。前端一律**以数组为准**，
 * 单值只是它的首项——所有读写都从这里过，别再直接拼 `sourceUrl`。
 */

type WithSourceUrls = {
  sourceUrls?: string[] | null;
  sourceUrl?: string | null;
};

/** 去空 + 去重，保序（顺序即 UI 显示顺序）。 */
export function dedupeSourceUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const u = (raw || '').trim();
    if (!u || out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

/** 取这张图的来源网址列表。永远返回数组（没有就是 []），不会返回 undefined。 */
export function getSourceUrls(file: WithSourceUrls | undefined | null): string[] {
  if (!file) return [];
  if (Array.isArray(file.sourceUrls) && file.sourceUrls.length > 0) {
    return dedupeSourceUrls(file.sourceUrls);
  }
  return file.sourceUrl ? [file.sourceUrl] : [];
}

/** 归一化成落 state 的形态：有网址给数组，没有给 undefined（省一层空数组）。 */
export function normalizeSourceUrls(urls?: string[] | null, single?: string | null): string[] | undefined {
  const list = getSourceUrls({ sourceUrls: urls, sourceUrl: single });
  return list.length > 0 ? list : undefined;
}

/** 写库用：把列表压成「数组 + 首项」两个字段，老字段跟着同步，两边不会分叉。 */
export function toSourceUrlFields(urls: string[]): { sourceUrls: string[]; sourceUrl?: string } {
  const cleaned = dedupeSourceUrls(urls);
  return { sourceUrls: cleaned, sourceUrl: cleaned.length > 0 ? cleaned[0] : undefined };
}

/** 追加一条（去空、去重）。已经在里面就原样返回。 */
export function appendSourceUrl(urls: string[] | undefined, url: string): string[] {
  const current = urls || [];
  const trimmed = (url || '').trim();
  if (!trimmed || current.includes(trimmed)) return current;
  return [...current, trimmed];
}

/** 删掉一条。 */
export function removeSourceUrl(urls: string[] | undefined, url: string): string[] {
  return (urls || []).filter(u => u !== url);
}

/**
 * 就地改一条。
 *
 * 新值为空 = **取消这次编辑**（要删请走 `removeSourceUrl` 的 ×），免得手滑清空把网址弄丢；
 * 与其它条撞了就并成一条。
 */
export function replaceSourceUrl(urls: string[] | undefined, oldUrl: string, newUrl: string): string[] {
  const current = urls || [];
  const trimmed = (newUrl || '').trim();
  if (!trimmed) return current;
  const idx = current.indexOf(oldUrl);
  if (idx < 0) return current;
  return dedupeSourceUrls(current.map((u, i) => (i === idx ? trimmed : u)));
}
