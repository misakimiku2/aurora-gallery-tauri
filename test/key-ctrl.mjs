// 冒烟辅助:三段式组合键(Ctrl down → key → Ctrl up;cdp.mjs 单发 modifiers 不进 WebView2)
// 用法:node test/key-ctrl.mjs [wsUrl] [key] [ctrl|shift|alt|ctrl,alt|ctrl,shift,alt]
const WebSocket = (await import('ws')).default;
const [, , wsArg, key = 't', modArg = 'ctrl'] = process.argv;
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
// 多个修饰键 = 多段 down/up(flag 累加;Ctrl2/Alt1/Shift8)
const mods = modArg.split(',').map((s) => s.trim()).filter(Boolean);
const flag = mods.reduce((a, m) => a + (m === 'ctrl' ? 2 : m === 'alt' ? 1 : m === 'shift' ? 8 : 0), 0);
const VK = { ctrl: [17, 'ControlLeft', 'Control'], alt: [18, 'AltLeft', 'Alt'], shift: [16, 'ShiftLeft', 'Shift'] };
for (const m of mods) {
  const [vk, code, name] = VK[m] ?? VK.ctrl;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: vk, code, key: name, modifiers: flag });
}
await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), code: `Key${key.toUpperCase()}`, key, modifiers: flag });
await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), code: `Key${key.toUpperCase()}`, key, modifiers: flag });
for (const m of [...mods].reverse()) {
  const [vk, code, name] = VK[m] ?? VK.ctrl;
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, code, key: name, modifiers: 0 });
}
await new Promise((r) => setTimeout(r, 400));
console.log(`${modArg}+${key} sent`);
process.exit(0);
