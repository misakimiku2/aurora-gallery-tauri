// 非破坏验证:进裁剪态图片无大小变化 + 取消裁剪回退(真图上直接测,不碰保存)
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && p.title === 'Aurora Gallery');
if (!page) throw new Error('page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imgRect = async () => JSON.parse(await evaluate(`(function(){ var cv = document.querySelector('canvas[data-adjust-canvas]'); var r = cv.getBoundingClientRect(); var v = window.__adjustView; return JSON.stringify({ iw: Math.round((v.iw/v.bw)*r.width), ih: Math.round((v.ih/v.bh)*r.height), left: Math.round(r.left + (v.ix/v.bw)*r.width), top: Math.round(r.top + (v.iy/v.bh)*r.height) }); })()`));

const pre = await imgRect();
console.log('pre-crop   :', JSON.stringify(pre));
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('#aurora-adjust-slot button')).find(function(x){ return x.getAttribute('title') === '裁剪'; }); if(b) b.click(); return 1; })()`);
await sleep(800);
const toolbar = await evaluate(`!!document.querySelector('[data-crop-toolbar]')`);
const inCrop = await imgRect();
console.log('in-crop    :', JSON.stringify(inCrop), 'toolbar:', toolbar);
const same = Math.abs(inCrop.iw - pre.iw) <= 2 && Math.abs(inCrop.ih - pre.ih) <= 2 && Math.abs(inCrop.left - pre.left) <= 2 && Math.abs(inCrop.top - pre.top) <= 2;
console.log(same ? '✓ 进裁剪态图片无大小变化' : '✗ 图片尺寸变了!');
await evaluate(`(function(){ var b = Array.from(document.querySelectorAll('[data-crop-toolbar] button')).find(function(x){ return x.textContent.trim() === '取消裁剪'; }); if(b) b.click(); return 1; })()`);
await sleep(600);
const after = await imgRect();
const restored = Math.abs(after.iw - pre.iw) <= 2 && Math.abs(after.ih - pre.ih) <= 2;
console.log('after-cancel:', JSON.stringify(after), restored ? '✓ 已回退到进态前' : '✗ 未回退');
process.exit(same && restored && toolbar ? 0 : 1);
