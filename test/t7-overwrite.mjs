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
const mouse = async (type, x, y, extra = {}) => {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' || type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra });
};
const drag = async (x1, y1, x2, y2, steps = 8) => {
  await mouse('mousePressed', x1, y1);
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1); await sleep(16); }
  await mouse('mouseReleased', x2, y2);
};
// 拖亮度(制造调整)
const slider = JSON.parse(await evaluate(`(function(){ var i = document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); var inp = i[i.length-5]; var r = inp.getBoundingClientRect(); return JSON.stringify({left: r.x, right: r.x+r.width, y: r.y+r.height/2}); })()`));
await drag(slider.left + 10, slider.y, slider.right - 40, slider.y);
await sleep(400);
// 展开菜单 → 点蓝色"保存"(覆盖原图)
await evaluate(`(function(){ var btns = Array.from(document.querySelectorAll('#aurora-adjust-slot button')); var chev = btns.find(function(b){ return b.querySelector('.lucide-chevron-down'); }); chev.click(); return 1; })()`);
await sleep(300);
const saveBtn = JSON.parse(await evaluate(`(function(){ var slot = document.getElementById('aurora-adjust-slot'); var b = Array.from(slot.querySelectorAll('button')).find(function(x){ return x.textContent.trim() === '保存'; }); if(!b) return JSON.stringify({found:false}); var r = b.getBoundingClientRect(); var cs = getComputedStyle(b); return JSON.stringify({found:true, x: r.x+r.width/2, y: r.y+r.height/2, bg: cs.backgroundColor, disabled: b.disabled}); })()`));
console.log('[T7] 保存钮:', JSON.stringify(saveBtn));
await mouse('mousePressed', saveBtn.x, saveBtn.y);
await mouse('mouseReleased', saveBtn.x, saveBtn.y);
await sleep(2500);
// 覆盖后:参数应清空(重开滑杆归零)+ 编辑钮失活
const after = JSON.parse(await evaluate(`(function(){ var b=document.querySelector('[title="调整"]'); var slot=document.getElementById('aurora-adjust-slot'); var i = slot.querySelectorAll('input[type="range"]'); return JSON.stringify({active: b.className.includes('text-blue-500'), brightness: i.length ? i[i.length-5].value : 'n/a', inputCount: i.length}); })()`));
console.log('[T7] 覆盖后状态:', JSON.stringify(after));
process.exit(0);
