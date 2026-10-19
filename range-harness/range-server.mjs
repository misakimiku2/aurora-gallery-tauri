// 桌面拖拽实时预览测量台架：支持 Range 的本地 HTTP，可配「单次响应最大字节数」与「每发固定耗时」
// 用法: node range-server.mjs <port> <maxChunkBytes|0> <perRequestDelayMs|0> <name=path> ...
import http from 'node:http';
import fs from 'node:fs';

const [PORT, MAX_CHUNK, DELAY, MAX_CONN, ...FILES] = process.argv.slice(2);
const port = Number(PORT);
const cap = Number(MAX_CHUNK);
const perReqDelay = Number(DELAY || 0);
/** 并发上限。浏览器对同一 host 默认开 6 条连接，但 asset 协议那层桥**可能是串行的**，
 *  所以这里可以压成 1 来模拟最坏情况。0 = 不限。 */
const maxConn = Number(MAX_CONN || 0);
const videos = {};
for (const spec of FILES) {
  const i = spec.indexOf('=');
  videos[spec.slice(0, i)] = { path: spec.slice(i + 1), size: fs.statSync(spec.slice(i + 1)).size };
}
const stats = { requests: 0, bytes: 0, log: [], t0: Date.now() };
let inflight = 0;
const queue = [];

const PAGE = (name) => `<!doctype html><meta charset=utf-8><title>harness</title>
<body style="background:#111;color:#eee;font:13px monospace">
<video id=v width=640 height=360 preload=auto muted src="/media/${name}"></video>
<pre id=out>ready</pre>
<script>
const v = document.getElementById('v'), out = document.getElementById('out'), rows = [];
const wait = (ev) => new Promise(r => v.addEventListener(ev, r, { once: true }));
const stat = async () => (await fetch('/stats')).json();
const covered = (t) => { const b = v.buffered; for (let j = 0; j < b.length; j++) if (t >= b.start(j) && t + 0.2 <= b.end(j)) return true; return false; };
async function seekTo(t) {
  const before = await stat();
  const inBuf = covered(t);
  const t0 = performance.now();
  v.currentTime = t;
  await Promise.race([wait('seeked'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
  const ms = performance.now() - t0;
  await new Promise(r => setTimeout(r, 150));          // 让在途请求落地再取增量
  const after = await stat();
  return { t: +t.toFixed(2), inBuf, ms: +ms.toFixed(0), req: after.requests - before.requests, bytes: after.bytes - before.bytes };
}
window.boot = async (preload) => {
  // 量「点开一只片子到能播」到底花多少时间、发多少请求。
  // 用**游离元素**（不进 DOM）：画面不会渲染到用户屏幕上，事件照发。
  const s0 = await stat();
  const vv = document.createElement('video');
  vv.muted = true; vv.preload = preload || 'metadata';
  const t0 = performance.now(); const marks = {};
  for (const e of ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough'])
    vv.addEventListener(e, () => { if (!marks[e]) marks[e] = +(performance.now() - t0).toFixed(0); }, { once: true });
  const done = new Promise((res, rej) => {
    vv.addEventListener('loadeddata', res, { once: true });
    setTimeout(() => rej(new Error('boot timeout')), 60000);
  });
  vv.src = '/media/' + location.pathname.split('/')[2];
  const req0 = s0.requests, by0 = s0.bytes;
  await done;
  const s1 = await stat();
  return { dur: +vv.duration.toFixed(1), w: vv.videoWidth, h: vv.videoHeight,
           marks, ms: +(performance.now() - t0).toFixed(0),
           req: s1.requests - req0, bytes: +((s1.bytes - by0) / 1048576).toFixed(2) };
};
window.run = async (fracs) => {
  if (v.readyState < 1) await wait('loadedmetadata');
  const d = v.duration, res = [];
  for (const pass of ['cold', 'warm']) {               // cold=首次(多在缓冲外)，warm=已囤过一遍(多在缓冲内)
    for (const f of fracs) {
      const s = await seekTo(d * f);
      s.pass = pass; s.f = f; s.d = d;
      res.push(s); rows.push(JSON.stringify(s)); out.textContent = rows.join('\\n');
    }
  }
  return res;
};
</script>`;

const CLEAN = (name, preload) => `<!doctype html><meta charset=utf-8><title>boot</title>
<body style="background:#111;color:#eee;font:13px monospace"><pre id=out>idle</pre>
<script>
// 干净页：**没有**任何自动加载的 <video>，只有 boot() 现造的游离元素（不进 DOM → 画面不上屏）。
const wait=(e)=>new Promise(r=>e.addEventListener('loadeddata',r,{once:true}));
window.boot = async () => {
  const r0 = await (await fetch('/stats/reset')).json();
  const v = document.createElement('video');
  v.muted = true; v.preload = '${preload}';
  const t0 = performance.now(); const marks = {};
  for (const ev of ['loadedmetadata','loadeddata','canplay','canplaythrough'])
    v.addEventListener(ev, () => { if (!marks[ev]) marks[ev] = +(performance.now() - t0).toFixed(0); }, { once: true });
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('boot timeout')), 90000));
  v.src = '/media/${name}';
  const done = new Promise((res) => v.addEventListener('loadeddata', res, { once: true }));
  await Promise.race([done, timer]);
  await new Promise((r) => setTimeout(r, 250));   // 让在途请求落地再取增量
  const st = await (await fetch('/stats?n=4000')).json();
  const L = st.log || [];
  const hist = {};
  for (const e of L) { const b = e.len < 64 ? '<64B' : e.len < 4096 ? '<4K' : e.len < 65536 ? '<64K'
    : e.len < 1048576 ? '<1M' : '1M+'; hist[b] = (hist[b] || 0) + 1; }
  const gaps = []; for (let i = 1; i < L.length; i++) gaps.push(L[i].at - L[i - 1].at);
  return { preload: v.preload, dur: +v.duration.toFixed(1), size: v.videoWidth + 'x' + v.videoHeight,
    readyState: v.readyState, marks, ms: +(performance.now() - t0).toFixed(0),
    req: L.length, servedMiB: +((st.bytes || 0) / 1048576).toFixed(2),
    firstBytes: L.slice(0, 6).map((e) => e.s + '-' + e.e),
    lastBytes: L.slice(-3).map((e) => e.s + '-' + e.e),
    sizeHist: hist, maxInflight: Math.max(0, ...L.map((e) => e.in)),
    gapMed: gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] };
};
</script></body>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/stats') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ requests: stats.requests, bytes: stats.bytes, log: stats.log.slice(-Number(u.searchParams.get('n') || 0) || undefined) })); }
  if (u.pathname === '/stats/reset') { stats.requests = 0; stats.bytes = 0; stats.log = []; stats.t0 = Date.now(); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: 1 })); }
  const cl = u.pathname.match(/^\/clean\/([^/]+)\/(metadata|auto)$/);
  if (cl && videos[cl[1]]) { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(CLEAN(cl[1], cl[2])); }
  const pg = u.pathname.match(/^\/page\/(.+)$/);
  if (pg && videos[pg[1]]) { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(PAGE(pg[1])); }
  const m = u.pathname.match(/^\/media\/(.+)$/);
  if (!m || !videos[m[1]]) { res.statusCode = 404; return res.end('nf'); }
  const { path, size } = videos[m[1]];

  const range = req.headers.range;
  let start = 0, end = size - 1;
  if (range) {
    const [, a, b] = range.match(/bytes=(\d*)-(\d*)/) || [];
    start = a ? Number(a) : 0;
    end = b ? Math.min(Number(b), size - 1) : size - 1;
    if (cap > 0 && end - start + 1 > cap) end = start + cap - 1;   // 照 asset.rs:134 静默截断
  }
  const len = end - start + 1;
  stats.requests += 1;
  stats.log.push({ s: start, e: end, len, at: Date.now() - stats.t0, in: inflight });
  const head = {
    'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': len,
    'content-range': range ? `bytes ${start}-${end}/${size}` : undefined,
  };
  if (inflight >= maxConn && maxConn > 0) {
    // 排队：模拟桥层串行时，后到的请求必须等前面那批发完
    await new Promise(r => queue.push(r));
  }
  inflight += 1;
  try {
    if (perReqDelay > 0) await new Promise(r => setTimeout(r, perReqDelay));
    res.writeHead(range ? 206 : 200, head);
    const stream = fs.createReadStream(path, { start, end });
    // 客户端（Chromium 经常）中途 abort：必须真的停手，否则「在途」数会假涨、
    // 而且会把整只文件_pipe_给一个早就不要了的连接，把吞吐量成天文数字。
    stream.on('data', (c) => { stats.bytes += c.length; });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    // 用 finish 而不是 close 释放通道：keep-alive 下 close 要等整条连接拆掉，
    // 那会把「串行」错做成「一条连接独占」，把并发模型量成饿死。
    await new Promise(r => { res.on('finish', r); res.on('close', r); });
  } finally {
    inflight -= 1;
    const next = queue.shift();
    if (next) next();
  }
}).listen(port, '127.0.0.1', () =>
  console.log(`READY cap=${cap} port=${port} delay=${perReqDelay}ms maxConn=${maxConn} ` +
    Object.entries(videos).map(([k, v]) => `${k}=${v.size}`).join(' ')));
