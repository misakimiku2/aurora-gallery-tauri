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
const stats = { requests: 0, bytes: 0 };
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

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/stats') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(stats)); }
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
  stats.requests += 1; stats.bytes += len;
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
    fs.createReadStream(path, { start, end }).pipe(res);
    // 用 finish 而不是 close 释放通道：keep-alive 下 close 要等整条连接拆掉，
    // 那会把「串行」错做成「一条连接独占」，把并发模型量成饿死。
    await new Promise(r => res.on('finish', r));
  } finally {
    inflight -= 1;
    const next = queue.shift();
    if (next) next();
  }
}).listen(port, '127.0.0.1', () =>
  console.log(`READY cap=${cap} port=${port} delay=${perReqDelay}ms maxConn=${maxConn} ` +
    Object.entries(videos).map(([k, v]) => `${k}=${v.size}`).join(' ')));
