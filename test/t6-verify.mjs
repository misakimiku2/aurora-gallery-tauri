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
const slider = JSON.parse(await evaluate(`(function(){ var i = document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); var inp = i[i.length-5]; var r = inp.getBoundingClientRect(); return JSON.stringify({x: r.x+r.width/2, y: r.y+r.height/2, left: r.x, right: r.x+r.width}); })()`));
await drag(slider.left + 10, slider.y, slider.right - 40, slider.y);
await sleep(400);
const dragged = await evaluate(`(function(){ var i = document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); return i[i.length-5].value; })()`);
console.log('[T6a] 拖亮度至', dragged);
// 关闭(顶栏编辑钮)
await evaluate(`document.querySelector('[title="调整"]').click()`);
await sleep(600);
const closed = JSON.parse(await evaluate(`(function(){ var b=document.querySelector('[title="调整"]'); var slot=document.getElementById('aurora-adjust-slot'); return JSON.stringify({active: b.className.includes('text-blue-500'), disp: getComputedStyle(slot).display}); })()`));
console.log('[T6b] 关闭后:', JSON.stringify(closed), closed.active === false && closed.disp === 'none' ? '✓ 已取消(参数清/面板关)' : '✗ FAIL');
// 重开 → 滑杆归零
await evaluate(`document.querySelector('[title="调整"]').click()`);
await sleep(800);
const reopened = await evaluate(`(function(){ var i = document.querySelectorAll('#aurora-adjust-slot input[type="range"]'); return i[i.length-5].value; })()`);
console.log('[T6c] 重开亮度值:', reopened, reopened === '0' ? '✓ 恢复原状态' : '✗ FAIL');
// 未调整时:另存为分体钮禁用 + 菜单里保存钮禁用置灰
const disabled = JSON.parse(await evaluate(`(function(){
  var slot = document.getElementById('aurora-adjust-slot');
  var btns = Array.from(slot.querySelectorAll('button'));
  var chev = btns.find(function(b){ return b.querySelector('.lucide-chevron-down'); });
  var main = btns.find(function(b){ return b.textContent.indexOf('另存为') >= 0; });
  var cs = getComputedStyle(chev);
  return JSON.stringify({ chevDisabled: chev.disabled, mainDisabled: main.disabled, chevBg: cs.backgroundColor });
})()`));
console.log('[T6d] 无调整时按钮禁用:', JSON.stringify(disabled));
process.exit(0);
