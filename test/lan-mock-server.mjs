// LAN 查看器竞态验证 mock 服务端（dac64a3b9 修复验收用）。
// 用法：node test/lan-mock-server.mjs  →  模拟器里连 http://10.0.2.2:18080，访问码任意 4 位。
//
// 刻意把「大图」变慢（服务端延迟而不是真大文件），让两条竞态确定性复现：
//  - A_red：full 200ms / thumb 4000ms —— 高清先到、缩略图迟到 4s（翻页停在缩略图的复现条件）
//  - C_blue：full 10000ms / thumb 12000ms —— 在途大图（点开别的图偶见错图的复现条件）
//  - B_green / D_yellow：full 800ms / 200ms
// 服务端日志打每个请求的「到达时刻」，与 logcat 的 skip/discard 日志对账。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'lan-mock-assets');
const PORT = Number(process.argv[2] || 18080);
const TOKEN = 'mocktoken';

// browse 顺序即查看器序列：idx0=A(快) idx1=B(快) idx2=C(慢6s) idx3=D(快)
// C 延迟 6s：晚于相邻图上屏（迟到覆盖窗口），但短于 Coil 默认 OkHttp 10s 读超时
const IMAGES = [
  { name: 'A_red.jpg', path: 'mock/A_red.jpg', full: 'A_red.jpg', thumb: 'A_red_thumb.jpg', imageDelay: 200, thumbDelay: 4000 },
  { name: 'C_blue.jpg', path: 'mock/C_blue.jpg', full: 'C_blue.jpg', thumb: 'C_blue_thumb.jpg', imageDelay: 6000, thumbDelay: 7000 },
  { name: 'B_green.jpg', path: 'mock/B_green.jpg', full: 'B_green.jpg', thumb: 'B_green_thumb.jpg', imageDelay: 800, thumbDelay: 4000 },
  { name: 'D_yellow.jpg', path: 'mock/D_yellow.jpg', full: 'D_yellow.jpg', thumb: 'D_yellow_thumb.jpg', imageDelay: 200, thumbDelay: 4000 },
];

const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const t0 = Date.now();
const log = (msg) => console.log(`[+${String((Date.now() - t0) / 1000).padStart(6)}s] ${msg}`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://x`);
  const p = url.pathname;
  const at = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

  if (p === '/api/auth/verify') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      log(`verify code=${JSON.parse(body || '{}').code} → ok`);
      json(res, { success: true, token: TOKEN, expires_in: 86400, server_name: 'MockServ' });
    });
    return;
  }
  if (p === '/api/heartbeat') return json(res, {});
  if (p === '/api/all_image_folders') {
    return json(res, {
      folders: [{ name: 'mock', path: 'mock', size: IMAGES.length, preview_images: [`mock/${IMAGES[0].full}`] }],
      root_images: [],
      allow_edit: false,
      allow_upload: false,
    });
  }
  if (p === '/api/browse') {
    log(`browse path=${url.searchParams.get('path')}`);
    return json(res, {
      current_path: url.searchParams.get('path') || 'mock',
      folders: [],
      images: IMAGES.map((i) => ({ name: i.name, path: i.path, type: 'image', size: 40000 })),
      allow_edit: false,
      allow_upload: false,
    });
  }
  if (p === '/api/metadata/batch' || p === '/api/metadata') return json(res, { items: [] });
  if (p === '/api/topics') return json(res, { topics: [] });
  if (p === '/api/people') return json(res, { people: [] });
  if (p === '/api/vocab') return json(res, { tags: [] });
  if (p === '/api/topic/members') return json(res, { files: [], people: [] });

  if (p === '/api/image' || p === '/api/thumbnail') {
    const path = url.searchParams.get('path') || '';
    const img = IMAGES.find((i) => i.path === path);
    if (!img) {
      log(`${p} 404 path=${path}`);
      return json(res, { error: 'not found' }, 404);
    }
    const isThumb = p === '/api/thumbnail';
    const delay = isThumb ? img.thumbDelay : img.imageDelay;
    const file = isThumb ? img.thumb : img.full;
    // 记录「开始」与「实际写回」两个时刻，写回时刻即客户端可见的到达顺序
    setTimeout(() => {
      log(`${isThumb ? 'THUMB' : 'FULL '} → ${img.name} (delayed ${delay}ms)`);
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(readFileSync(join(ROOT, file)));
    }, delay);
    return;
  }

  log(`UNHANDLED ${req.method} ${p}`);
  json(res, {});
});

server.listen(PORT, '0.0.0.0', () => log(`mock LAN server on 0.0.0.0:${PORT} (token=${TOKEN})`));
