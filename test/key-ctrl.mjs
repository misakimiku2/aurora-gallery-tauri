// 冒烟辅助:三段式组合键(Ctrl down → key → Ctrl up;cdp.mjs 单发 modifiers 不进 WebView2)
// 用法:node test/key-ctrl.mjs [wsUrl] [key] [ctrl|shift|alt]
const WebSocket = (await import('ws')).default;
const [, , wsArg, key = 't', mod = 'ctrl'] = process.argv;
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:14422'));
const ws = new WebSocket(wsArg || page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.on('message', (m) => {
  let d;
  try { d = JSON.parse(String(m)); } catch { return; }
  if (d && d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); }
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
const flag = mod === 'ctrl' ? 2 : mod === 'alt' ? 1 : mod === 'shift' ? 8 : 2;
const down = { type: 'rawKeyDown', windowsVirtualKeyCode: 17, code: 'ControlLeft', key: 'Control', modifiers: flag };
if (mod === 'shift') { down.windowsVirtualKeyCode = 16; down.code = 'ShiftLeft'; down.key = 'Shift'; }
if (mod === 'alt') { down.windowsVirtualKeyCode = 18; down.code = 'AltLeft'; down.key = 'Alt'; }
await send('Input.dispatchKeyEvent', down);
await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), code: `Key${key.toUpperCase()}`, key, modifiers: flag });
await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), code: `Key${key.toUpperCase()}`, key, modifiers: flag });
await send('Input.dispatchKeyEvent', { ...down, type: 'keyUp', modifiers: 0 });
await new Promise((r) => setTimeout(r, 400));
console.log(`${mod}+${key} sent`);
process.exit(0);
