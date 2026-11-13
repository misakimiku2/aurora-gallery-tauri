// T17:另存为全链路冒烟 —— 副本图 → 调亮度 → 另存为 →
//   A. -edited 新文件即时入网格(不手动刷新,验证 metadata-updated 插入);
//   B. 原图立即复位(adjustStore 清空 + 滑杆归零,验证 resetHard)。
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /localhost:14422/.test(p.url));
if (!page) { console.log('NO-PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rectOf = (sel) => evaluate(`(function(){ var e=document.querySelector('${sel}'); if(!e) return null; var r=e.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`).then(JSON.parse);
const click = async (sel) => {
  const r = await rectOf(sel);
  if (!r) throw new Error('not found: ' + sel);
  const x = r.x + r.w / 2, y = r.y + r.h / 2;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};
const dblclick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
};
const drag = async (x1, y1, x2, y2, steps = 8) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / steps, y: y1, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
};
const SRC = 't17-smoke-src.jpg';
const OUT = 't17-smoke-src-edited.jpg';
const SRC_KEY = 'C:/Users/misakimiku/Videos/NVIDIA/' + SRC;

// 1. 刷新让副本入库
await click('[title="刷新"]');
let card = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  card = await evaluate(`!!document.querySelector('[title="${SRC}"]')`);
  if (card) break;
}
console.log('[T17-1] 刷新后副本卡片出现:', card);
if (!card) process.exit(1);

// 2. 双击图片区开查看器(标签上方 60px,双击标签=重命名)
const lbl = await rectOf(`[title="${SRC}"]`);
await dblclick(lbl.x + lbl.w / 2, lbl.y - 60);
await sleep(1200);
const editBtn = await evaluate(`(function(){ var b=document.querySelector('[title="编辑图片"]'); if(!b) return null; var r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`).then(JSON.parse);
console.log('[T17-2] 查看器+编辑图片按钮:', JSON.stringify(editBtn));
if (!editBtn) process.exit(1);

// 3. 进调整面板
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editBtn.x, y: editBtn.y, button: 'left', buttons: 1, clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editBtn.x, y: editBtn.y, button: 'left', buttons: 0, clickCount: 1 });
await sleep(800);
const sliders = await evaluate(`document.querySelectorAll('#aurora-adjust-slot input[type="range"]').length`);
console.log('[T17-3] 调整面板滑杆数:', sliders);
if (!sliders) process.exit(1);

// 4. 拖亮度滑杆制造调整 → 验证持久化链已把参数写进 adjustStore
const before = await evaluate(`(async function(){ var m = await import('/src/utils/adjustStore.ts'); return JSON.stringify(m.getAdjustParams('${SRC_KEY}')); })()`);
console.log('[T17-4] 拖动前 adjustStore:', before);
const sl = await evaluate(`(function(){ var i=document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); var inp=i[i.length-5]; var r=inp.getBoundingClientRect(); return JSON.stringify({left:r.x,right:r.x+r.width,y:r.y+r.height/2}); })()`).then(JSON.parse);
await drag(sl.left + 10, sl.y, sl.right - 40, sl.y);
await sleep(800);
const afterDrag = await evaluate(`(async function(){ var m = await import('/src/utils/adjustStore.ts'); var p=m.getAdjustParams('${SRC_KEY}'); return JSON.stringify(p ? p.tone : null); })()`);
console.log('[T17-4] 拖动后 adjustStore.tone:', afterDrag);

// 5. 另存为
const saveAs = await evaluate(`(function(){ var b=document.querySelector('#aurora-adjust-slot button[title="另存为"]'); if(!b) return null; var r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,disabled:b.disabled}); })()`).then(JSON.parse);
console.log('[T17-5] 另存为按钮:', JSON.stringify(saveAs));
if (!saveAs || saveAs.disabled) process.exit(1);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: saveAs.x, y: saveAs.y, button: 'left', buttons: 1, clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: saveAs.x, y: saveAs.y, button: 'left', buttons: 0, clickCount: 1 });

// 6. 断言 B:原图复位(adjustStore 清空 + 面板滑杆全归零 + 另存为按钮回置灰)——趁查看器还开着
await sleep(800);
const storeAfter = await evaluate(`(async function(){ var m = await import('/src/utils/adjustStore.ts'); return JSON.stringify(m.getAdjustParams('${SRC_KEY}')); })()`);
const sliderVals = await evaluate(`(function(){ var v=[]; document.querySelectorAll('#aurora-adjust-slot input[type="range"]').forEach(function(i){ v.push(i.value); }); return JSON.stringify(v); })()`);
const saveAsDisabled = await evaluate(`(function(){ var b=document.querySelector('#aurora-adjust-slot button[title="另存为"]'); return b ? b.disabled : 'gone'; })()`);
console.log('[T17-6] B. 复位后 adjustStore:', storeAfter, '| 滑杆值:', sliderVals, '| 另存为钮disabled:', saveAsDisabled);

// 7. 断言 A:新文件卡片即时入网格(不刷新)。
//   ⚠️ 查看器开着时网格 DOM 不渲染(虚拟化),先关查看器回网格再查——
//   第一版在这里直接查,永远 false,差点误判插入逻辑坏了(state.files 里其实已有节点)。
for (let i = 0; i < 2; i++) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(600);
}
await sleep(1000);
let newCard = await evaluate(`!!document.querySelector('[title="${OUT}"]')`);
for (let i = 0; i < 10 && !newCard; i++) {
  await sleep(500);
  newCard = await evaluate(`!!document.querySelector('[title="${OUT}"]')`);
}
console.log('[T17-7] A. -edited 卡片即时入网格(未手动刷新):', newCard);

// 8. 截图存档
await send('Page.enable');
const shot = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('fs');
fs.writeFileSync('test/t17-after-saveas.png', Buffer.from(shot.data, 'base64'));
console.log('[T17-8] 截图 → test/t17-after-saveas.png');
process.exit(0);
