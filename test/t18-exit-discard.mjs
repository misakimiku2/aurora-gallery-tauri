// T18:编辑中途退出查看器 = 会话丢弃(轻量编辑器语义,2026-11-14 用户拍板)
//   编辑 A → 直接后退关查看器 → 参数行清空/面板关/角标消 → 再进=普通查看态,滑杆全新
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /localhost:14422/.test(p.url));
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
const mouseClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};
const dblclick = async (x, y) => {
  await mouseClick(x, y); await sleep(60);
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
const SRC = 't18-smoke-src.jpg';
const SRC_KEY = 'C:/Users/misakimiku/Videos/NVIDIA/' + SRC;
const storeOf = (key) => evaluate(`(async function(){ var m = await import('/src/utils/adjustStore.ts'); var p = m.getAdjustParams('${key}'); return JSON.stringify(p ? p.tone.brightness : null); })()`);

// 0. ⚠️ 不要 Page.reload:会触发应用既有 boot 脆弱性(StrictMode 双跑 init,saved-data
//    一旦抛异常落 mock 兜底,把 rootPaths 改写成 C:/Photos,2026-11-14 实测)。
//    新代码靠重启 exe 加载;冒烟内绝不刷新页面。

// 1. 刷新按钮让副本入库
const rf = await rectOf('[title="刷新"]');
await mouseClick(rf.x + rf.w / 2, rf.y + rf.h / 2);
let card = null;
for (let i = 0; i < 30; i++) { await sleep(500); card = await evaluate(`!!document.querySelector('[title="${SRC}"]')`); if (card) break; }
console.log('[T18-1] 副本入库:', card);
if (!card) process.exit(1);

// 2. 双击开查看器 → 编辑图片 → 拖亮度
const lbl = await rectOf(`[title="${SRC}"]`);
await dblclick(lbl.x + lbl.w / 2, lbl.y - 60);
await sleep(1200);
const eb = await evaluate(`(function(){ var b=document.querySelector('[title="编辑图片"]'); if(!b) return null; var r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`).then(JSON.parse);
await mouseClick(eb.x, eb.y);
await sleep(800);
const sl = await evaluate(`(function(){ var i=document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); if(!i.length) return null; var r=i[i.length-5].getBoundingClientRect(); return JSON.stringify({left:r.x,right:r.x+r.width,y:r.y+r.height/2}); })()`).then(JSON.parse);
await drag(sl.left + 10, sl.y, sl.right - 40, sl.y);
await sleep(900);
console.log('[T18-2] 编辑中 store.brightness(应 0.72):', await storeOf(SRC_KEY));

// 3. 后退关查看器(编辑中途直接退出)
const bk = await rectOf('[title="后退"]');
await mouseClick(bk.x + bk.w / 2, bk.y + bk.h / 2);
await sleep(1000);
const ui = await evaluate(`(async function(){ var m = await import('/src/utils/adjustStore.ts'); return JSON.stringify(m.getAdjustUi()); })()`);
console.log('[T18-3] 退出后 store.brightness(应 null):', await storeOf(SRC_KEY), '| adjustUi:', ui);

// 4. 再进查看器:应是普通查看态(面板关、无编辑残留)
await dblclick(lbl.x + lbl.w / 2, lbl.y - 60);
await sleep(1200);
const reopened = await evaluate(`(function(){ var slot=document.getElementById('aurora-adjust-slot'); return JSON.stringify({ slotInputs: slot ? slot.querySelectorAll('input').length : -1 }); })()`).then(JSON.parse);
console.log('[T18-4] 再进后面板输入框数(应 0):', reopened.slotInputs);
// 5. 再点编辑图片:滑杆全新(全 0)
const eb2 = await evaluate(`(function(){ var b=document.querySelector('[title="编辑图片"]'); if(!b) return null; var r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`).then(JSON.parse);
await mouseClick(eb2.x, eb2.y);
await sleep(800);
const vals = await evaluate(`(function(){ var v=[]; document.querySelectorAll('#aurora-adjust-slot input[type="range"]').forEach(function(i){ v.push(i.value); }); return JSON.stringify(v); })()`);
console.log('[T18-5] 重开编辑滑杆值(应全 0):', vals);
const shot = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('fs');
fs.writeFileSync('test/t18-reopened.png', Buffer.from(shot.data, 'base64'));
process.exit(0);
