#!/usr/bin/env node
/**
 * 把发布产物与更新清单推到 Gitee 发布仓库（中国大陆直连镜像）。
 *
 * Gitee 只是发布渠道：不放代码、也不会自动跟 GitHub 同步。这里只动两处——
 * Release 的附件，和仓库里的 `update/*.json` 两份清单。
 *
 * 用法（先 --dry-run 看预检，再正式发）：
 *   node scripts/publish-gitee.mjs --tag v2.1.0 \
 *     --notes docs/RELEASE-NOTES-v2.1.0.md \
 *     --file release-out/v2.1.0/AuroraGallery-v2.1.0.apk \
 *     --file release-out/v2.1.0/Aurora.Gallery_2.1.0_x64-setup.exe \
 *     --file release-out/v2.1.0/Aurora.Gallery_2.1.0_x64_en-US.msi \
 *     --manifest update/android.json --manifest update/desktop.json --dry-run
 *
 * Gitee 的四条脾气（端点行为实测于 2026-09-29 的 v2.1.0 发布，范本见 Nexus Editor 的
 * scripts/mirror-gitee.mjs）：
 *   1. 建 release 必须同时给 `target_commitish` 与 `body`，缺任一个只回一句 messages；
 *   2. 附件走 `POST /releases/{id}/attach_files`，`access_token` **必须在 query 上**——
 *      当 multipart 字段传会返回空响应、附件静默不落地；
 *   3. 同名附件**不覆盖**，直链永远返回第一次那份 → 重跑要删同 tag 的 release 重建；
 *   4. `attach_files` 收完整个包才回话，undici（Node fetch）默认 300s 就把响应头判超时，
 *      于是把"慢但在传"报成失败 → 上传这一路走 `node:https`。
 *
 * 顺序刻意是「先附件、后清单」：反过来的话会留出一段清单已指向新 tag、附件还 404 的窗口，
 * 而桌面二维码里的 APK 直链是实时从 Gitee 那份清单取的。
 */
import { readFileSync, existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:https";

const API = "https://gitee.com/api/v5";
/** 一律用 path.resolve：new URL('C:/x') 会把 C: 当协议名，Windows 绝对路径会解析到错的文件 */
const toAbs = p => resolve(p);
const arg = n => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const all = n => process.argv.reduce((a, v, i) => (v === `--${n}` ? [...a, process.argv[i + 1]] : a), []);
const hasFlag = n => process.argv.includes(`--${n}`);
const DRY = hasFlag("dry-run");
const SKIP_HASH = hasFlag("skip-hash");

const repo = arg("repo") || "misakimiku2/aurora_gallery";
const tag = arg("tag");
const notesPath = arg("notes");
const files = all("file").map(f => ({ abs: toAbs(f), name: basename(f) }));
/**
 * 清单在发布仓里的路径必须是 `update/xxx.json`，不能是光秃秃的文件名：
 * 客户端 raw 直链读的就是 update/ 下那份（实测 Gitee `update/android.json` 302、根目录
 * `android.json` 404），早期版本把 basename 传给 contents API 会静默写错位置。
 * `repo-root` 用来把传入路径折算成相对发布仓的路径，默认取当前工作目录。
 */
const REPO_ROOT = toAbs(arg("repo-root") || ".");
const manifests = all("manifest").map(p => ({
  abs: toAbs(p),
  repo: relative(REPO_ROOT, toAbs(p)).split("\\").join("/"),
}));

const tokenFile = `${process.env.USERPROFILE || process.env.HOME}/.gitee_token`;
const token = (process.env.GITEE_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "")).trim();
const safe = s => String(s).split(token).join("<redacted>");

if (!token || !tag || files.length === 0 || manifests.length === 0) {
  console.error("缺参数：需要 --tag、至少一个 --file、至少一个 --manifest，以及 GITEE_TOKEN 或 ~/.gitee_token");
  process.exit(1);
}
for (const f of files) if (!existsSync(f.abs)) { console.error(`产物不存在：${f.abs}`); process.exit(1); }

async function api(label, path, init) {
  const url = `${API}/${path}${path.includes("?") ? "&" : "?"}access_token=${token}`;
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} 失败：HTTP ${res.status} ${safe(text).slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** 大文件上传不能用 fetch（见文件头第 4 条）。 */
function postMultipart(pathWithQuery, filePath, fileName, timeoutMs = 20 * 60_000) {
  return new Promise((resolveP, reject) => {
    const boundary = `----aurora${Date.now().toString(36)}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const body = Buffer.concat([head, readFileSync(filePath), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const req = request({
      hostname: "gitee.com", path: `/api/v5/${pathWithQuery}`, method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length) },
    }, res => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", c => { text += c; });
      res.on("end", () => resolveP({ status: res.statusCode ?? 0, text }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`上传 ${fileName}：${timeoutMs / 60000} 分钟内没有响应`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** 只读回链拿最终体积：Gitee 会忽略 Range 整包回，所以取响应头不取响应体。 */
async function verifySize(url, expectedSize) {
  const res = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
  if (!res.ok) throw new Error(`直链不可达：${url} → HTTP ${res.status}`);
  const range = res.headers.get("content-range");
  const total = range ? Number(range.split("/")[1]) : Number(res.headers.get("content-length"));
  if (Number.isFinite(total) && total !== expectedSize) throw new Error(`直链大小不符：${url} 声明 ${total}，本地 ${expectedSize}`);
  return Number.isFinite(total) ? total : expectedSize;
}

async function hashUrl(url) {
  return createHash("sha256").update(Buffer.from(await (await fetch(url)).arrayBuffer())).digest("hex");
}

/* 全流程包在 try 里：ESM 顶层抛出的 rejection 接不住，会甩一坨栈——发布常在半夜跑，
   要的是「中止：一句话」。 */
try {

/* ---------- 预检：清单必须如实描述本地字节，且直链指向本次 tag ---------- */
const local = {};
for (const f of files) {
  const buf = readFileSync(f.abs);
  local[f.name] = { size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}
for (const { abs, repo: rel } of manifests) {
  const m = JSON.parse(readFileSync(abs, "utf8"));
  for (const asset of m.assets ?? []) {
    const l = local[asset.name];
    if (!l) continue; // 该清单没声明本次上传的资产，跳过
    if (asset.size !== l.size) throw new Error(`${rel} 的 ${asset.name} size=${asset.size}，本地实为 ${l.size}`);
    if (asset.sha256 && asset.sha256 !== l.sha256) throw new Error(`${rel} 的 ${asset.name} sha256 与本地字节不符`);
    if (!asset.url.includes(`/releases/download/${tag}/`)) throw new Error(`${rel} 的 ${asset.name} url 没指向 ${tag}：${asset.url}`);
  }
}
const me = await api("鉴权", "user");
const meta = await api("仓库", `repos/${repo}`);
console.log(`预检通过：${me.login} · ${repo}（默认分支 ${meta.default_branch}）· ${files.length} 个产物 · ${manifests.length} 份清单`);
if (DRY) { console.log("--dry-run：不写入任何远端"); process.exit(0); }

/* ---------- 1) release：同名附件不覆盖，重跑删了重建 ---------- */
const releases = await api("列出 release", `repos/${repo}/releases`);
const existing = releases.find(r => r.tag_name === tag);
if (existing) {
  console.log(`已有 ${tag}（id ${existing.id}）→ 删除重建`);
  await api(`删除 release ${existing.id}`, `repos/${repo}/releases/${existing.id}`, { method: "DELETE" });
}
const notes = notesPath ? readFileSync(toAbs(notesPath), "utf8") : tag;
const created = await api(`创建 release ${tag}`, `repos/${repo}/releases`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    access_token: token, tag_name: tag,
    name: arg("release-name") || tag, body: notes, target_commitish: meta.default_branch,
  }),
});
if (!created.id) throw new Error("创建 release 响应里没有 id：" + safe(JSON.stringify(created)).slice(0, 200));
console.log(`✓ release ${tag}（id ${created.id}）`);

/* ---------- 2) 传附件 + 回读 ---------- */
for (const f of files) {
  const { status, text } = await postMultipart(
    `repos/${repo}/releases/${created.id}/attach_files?access_token=${token}`, f.abs, f.name);
  if (status < 200 || status >= 300) throw new Error(`上传 ${f.name} 失败：HTTP ${status} ${safe(text).slice(0, 300)}`);
  const asset = JSON.parse(text);
  if (!asset.browser_download_url) throw new Error(`上传 ${f.name}：响应里没有直链字段`);
  if (asset.name !== f.name) throw new Error(`上传 ${f.name}：Gitee 存成了 ${asset.name}，直链名对不上`);
  await verifySize(asset.browser_download_url, local[f.name].size);
  console.log(`✓ ${f.name} ${(local[f.name].size / 1048576).toFixed(1)} MB → ${asset.browser_download_url}`);
}

/* ---------- 3) 附件都可达了，才提交清单 ---------- */
for (const { abs, repo: rel } of manifests) {
  const cur = await api(`读远端 ${rel}`, `repos/${repo}/contents/${rel}?ref=${meta.default_branch}`);
  const put = await api(`更新 ${rel}`, `repos/${repo}/contents/${rel}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: token, content: readFileSync(abs).toString("base64"),
      sha: cur.sha, branch: meta.default_branch, message: `release: ${tag} 更新清单`,
    }),
  });
  console.log(`✓ ${rel} → commit ${String(put.commit?.sha ?? "").slice(0, 8)}`);
}

/* ---------- 4) 回读校验：raw 上的清单要指向本次 tag，直链体积/哈希要对 ---------- */
for (const { abs, repo: rel } of manifests) {
  const raw = await (await fetch(`https://gitee.com/${repo}/raw/${meta.default_branch}/${rel}?t=${Date.now()}`, { redirect: "follow" })).text();
  const remote = JSON.parse(raw);
  const want = JSON.parse(readFileSync(abs, "utf8"));
  if (remote.version !== want.version) throw new Error(`update/${rel} 远端版本 ${remote.version} ≠ 本地 ${want.version}`);
  for (const asset of remote.assets ?? []) {
    if (!local[asset.name]) continue;
    await verifySize(asset.url, asset.size);
    if (!SKIP_HASH && asset.sha256) {
      const got = await hashUrl(asset.url);
      if (got !== asset.sha256) throw new Error(`${asset.name} 从 Gitee 整包回读的 sha256 不符：${got.slice(0, 16)}… ≠ ${asset.sha256.slice(0, 16)}…`);
      console.log(`  ${asset.name} 整包回读哈希一致`);
    }
  }
  console.log(`✓ ${rel}：远端 version ${remote.version}，资产直链可达`);
}
console.log(`Gitee 发布完成：${repo} · ${tag}`);

} catch (err) {
  console.error("中止：" + (err?.message ?? err));
  process.exit(1);
}
