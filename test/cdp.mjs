// CDP 冒烟驱动:通过 Input.dispatchMouseEvent 走真实输入管线(React 合成指针事件
// + setPointerCapture 都有效;eval 派发的合成 PointerEvent 会让 capture 抛 NotFoundError)。
// 用法:node test/cdp.mjs <cmd> [args…]
//   eval <expr>          Runtime.evaluate(awaitPromise, returnByValue)
//   shot <file>          截图(png)
//   click <x> <y> [btn]  左/右键单击(btn: left|right)
//   drag <x1> <y1> <x2> <y2>  左键拖拽(16 步插值)
//   key <text>           Input.dispatchKeyEvent(rawKeyDown+keyUp, windowsVirtualKeyCode 按首字符)
const wsUrl = process.env.CDP_WS;
if (!wsUrl) { console.error('CDP_WS not set'); process.exit(2); }
const ws = new WebSocket(wsUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VK = { Backspace: 8, Delete: 46, Enter: 13, Escape: 27 };
const keyChar = (c) => c.toUpperCase().charCodeAt(0);

await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const [, , cmd, ...args] = process.argv;
try {
  if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: args[0], awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify(r.result?.value ?? r.result, null, 1));
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args[0], Buffer.from(r.data, 'base64'));
    console.log('saved', args[0]);
  } else if (cmd === 'click' || cmd === 'drag') {
    const btn = cmd === 'click' ? (args[2] ?? 'left') : 'left';
    // drag 可带第 5 参修饰键 alt/ctrl/shift(CDP modifiers:alt=1 ctrl=2 shift=8)
    const mods = (cmd === 'drag' ? (args[4] ?? '') : '').split(',').filter(Boolean);
    const flags = (mods.includes('ctrl') ? 2 : 0) | (mods.includes('shift') ? 8 : 0) | (mods.includes('alt') ? 1 : 0);
    const pts = cmd === 'click'
      ? [[+args[0], +args[1]]]
      : (() => {
        const [x1, y1, x2, y2] = args.map(Number);
        return Array.from({ length: 17 }, (_, i) => [x1 + ((x2 - x1) * i) / 16, y1 + ((y2 - y1) * i) / 16]);
      })();
    const [x0, y0] = pts[0];
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, modifiers: flags });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: btn, buttons: btn === 'left' ? 1 : 2, clickCount: 1, modifiers: flags });
    await sleep(60);
    for (const [x, y] of pts.slice(1)) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: btn, buttons: btn === 'left' ? 1 : 2, modifiers: flags });
      await sleep(24);
    }
    await sleep(60);
    const [xe, ye] = pts[pts.length - 1];
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xe, y: ye, button: btn, buttons: 0, clickCount: 1, modifiers: flags });
    console.log(cmd, 'done', mods.join('+'));
  } else if (cmd === 'key') {
    const k = args[0];
    const code = VK[k] ?? keyChar(k[0]);
    const mods = (args[1] ?? '').split(',').filter(Boolean);
    const flags = (mods.includes('ctrl') ? 2 : 0) | (mods.includes('shift') ? 8 : 0) | (mods.includes('alt') ? 1 : 0);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: code, code: args[2] ?? `Key${k.toUpperCase()}`, key: k, modifiers: flags });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, code: args[2] ?? `Key${k.toUpperCase()}`, key: k, modifiers: flags });
    console.log('key', k, mods.join('+'), 'done');
  } else {
    console.error('unknown cmd', cmd);
  }
} finally {
  ws.close();
}
