// 用法: node test/drop-file.mjs <wsUrl> <filePath> <fileName> — 合成拖放投到编辑器画布中心
// store 访问用 performance resources 里带 ?t= 的真实例(HMR 时间戳;裸 URL=陈旧副本)
const WebSocket = (await import('ws')).default;
const fs = (await import('node:fs')).default;
const [, , wsUrl, filePath, fileName] = process.argv;
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
ws.on('message', (m) => { const d = JSON.parse(String(m)); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.on('open', r));
const b64 = fs.readFileSync(filePath).toString('base64');
const expr = `(async () => {
  const urls = performance.getEntriesByType('resource').map(r => r.name).filter(n => n.includes('editorStore'));
  const storeUrl = urls[urls.length - 1];
  const bin = atob('${b64}');
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([u], '${fileName}', { type: 'image/jpeg' }));
  const wrap = document.querySelector('[data-editor-canvas]');
  const r = wrap.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  wrap.dispatchEvent(new DragEvent('dragenter', opts));
  await new Promise(res => setTimeout(res, 50));
  wrap.dispatchEvent(new DragEvent('drop', opts));
  await new Promise(res => setTimeout(res, 1500));
  const m = await import(storeUrl);
  const ds = m.debugSessions();
  const s = m.getSession(ds[ds.length - 1].tabId);
  return JSON.stringify({ layers: s.state?.layers?.map(l => l.name), revision: s.revision, tf: s.transform ? { rect: s.transform.rect } : null });
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.value ?? r.result?.description ?? r));
process.exit(0);
