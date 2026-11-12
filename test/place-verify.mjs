// 用法: node test/place-verify.mjs <wsUrl> <file> <name> <rectX0> <rectY0> <rectX1> <rectY1> <fx> <fy>
// drop → Enter → 检查:revision 前进 + 画布像素 == 引擎缩略图真值(同层同比例点)
const WebSocket = (await import('ws')).default;
const fs = (await import('node:fs')).default;
const [, , wsUrl, file, name, x0, y0, x1, y1, fx, fy] = process.argv;
const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
ws.on('message', (m) => { const d = JSON.parse(String(m)); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.on('open', r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = fs.readFileSync(file).toString('base64');
const storeUrlExpr = `performance.getEntriesByType('resource').map(r=>r.name).filter(n=>n.includes('editorStore')).pop()`;
const storeUrl = (await send('Runtime.evaluate', { expression: storeUrlExpr, returnByValue: true })).result?.result?.value;

// 1) drop
const dropExpr = `(async () => {
  const bin = atob('${b64}');
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([u], '${name}', { type: 'image/jpeg' }));
  const wrap = document.querySelector('[data-editor-canvas]');
  const r = wrap.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  wrap.dispatchEvent(new DragEvent('dragenter', opts));
  await new Promise(res => setTimeout(res, 50));
  wrap.dispatchEvent(new DragEvent('drop', opts));
  await new Promise(res => setTimeout(res, 1600));
  const m = await import('${storeUrl}');
  const s = m.debugSessions().map(x => m.getSession(x.tabId)).find(x => x.transform);
  return JSON.stringify({ rect: s?.transform?.rect ?? null });
})()`;
const dropRes = (await send('Runtime.evaluate', { expression: dropExpr, awaitPromise: true, returnByValue: true })).result?.result?.value;
console.log('placed:', dropRes);

// 2) Enter 提交
const vk = { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...vk });
await send('Input.dispatchKeyEvent', { type: 'keyDown', ...vk });
await send('Input.dispatchKeyEvent', { type: 'keyUp', ...vk });
await sleep(2600);

// 3) 检查
const checkExpr = `(async () => {
  const tb = await import('/src/components/editor/editorBridge.ts');
  const m = await import('${storeUrl}');
  const ds = m.debugSessions();
  const s = m.getSession(ds[ds.length - 1].tabId);
  const layer = s.state.layers.find(l => l.name === '${name.replace(/\.[^.]+$/, '')}');
  if (!layer) return JSON.stringify({ fail: 'layer missing', layers: s.state.layers.map(l => l.name) });
  const thumb = await tb.editorLayerThumbnail(s.docId, layer.id, 32);
  const tx = Math.min(thumb.width - 1, Math.floor(thumb.width * ${fx}));
  const ty = Math.min(thumb.height - 1, Math.floor(thumb.height * ${fy}));
  const ti = (ty * thumb.width + tx) * 4;
  const truth = [thumb.rgba[ti], thumb.rgba[ti + 1], thumb.rgba[ti + 2]];
  const rect = [${x0}, ${y0}, ${x1}, ${y1}];
  const docPt = [rect[0] + (rect[2] - rect[0]) * ${fx}, rect[1] + (rect[3] - rect[1]) * ${fy}];
  const v = s.runtime.view;
  const wrap = document.querySelector('[data-editor-canvas]');
  const dc = wrap.querySelectorAll('canvas')[0];
  const d = dc.getContext('2d').getImageData(Math.round(v.ox + docPt[0] * v.scale), Math.round(v.oy + docPt[1] * v.scale), 1, 1).data;
  const canvasPx = [d[0], d[1], d[2]];
  const dist = Math.abs(truth[0] - canvasPx[0]) + Math.abs(truth[1] - canvasPx[1]) + Math.abs(truth[2] - canvasPx[2]);
  return JSON.stringify({ rev: s.revision, hist: s.state.history.slice(-2), truth, canvasPx, match: dist < 30, dist });
})()`;
const checkRes = (await send('Runtime.evaluate', { expression: checkExpr, awaitPromise: true, returnByValue: true })).result?.result?.value;
console.log('checked:', checkRes);
process.exit(0);
