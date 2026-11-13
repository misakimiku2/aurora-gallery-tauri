// 右键「编辑图片」冒烟(2026-11-14 用户口径):
//   ① 文件网格右键图片 → 菜单有「编辑图片」→ 点击 → 查看器打开且直达调整态
//   ② 查看器右键 → 菜单有「编辑图片」→ 关调整后点它 → 面板重开
//   ③ 顶部编辑按钮 tooltip = 编辑图片
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
const mouse = async (type, x, y, extra = {}) => { await send('Input.dispatchMouseEvent', { type, x, y, button: extra.button || 'left', buttons: type === 'mouseMoved' ? 1 : (type === 'mousePressed' || type === 'mouseReleased' ? (extra.button === 'right' ? 2 : 1) : 0), clickCount: extra.clickCount ?? 1, ...extra }); };
let fail = 0;
const check = (name, ok, detail) => { console.log(`[${name}]`, detail, ok ? '✓' : '✗ FAIL'); if (!ok) fail++; };

// 0) 整页刷新(干净状态)
await send('Page.reload', { ignoreCache: true });
await sleep(5000);

// 1) 网格里右键第一张图片卡
let card = null;
for (let i = 0; i < 10 && !card; i++) {
  const ok = await evaluate(`(function(){ var el = Array.from(document.querySelectorAll('[title]')).find(function(x){ return /\\.(jpg|jpeg|png)$/i.test(x.getAttribute('title')||''); }); if(!el) return false; var r = el.getBoundingClientRect(); window.__card = { title: el.getAttribute('title'), x: r.x + r.width/2, y: r.y + Math.min(r.height/2, 80) }; return true; })()`);
  if (ok) card = JSON.parse(await evaluate('JSON.stringify(window.__card)'));
  else { await evaluate(`(function(){ var b = document.querySelector('[title*="刷新"], [title*="Refresh"]'); if(b) b.click(); return 1; })()`); await sleep(2500); }
}
if (!card) throw new Error('网格里没有图片卡');
await mouse('mousePressed', card.x, card.y, { button: 'right' });
await mouse('mouseReleased', card.x, card.y, { button: 'right' });
await sleep(700);
const hasItem = await evaluate(`(function(){ var m = document.querySelector('[data-testid="context-menu"]'); if(!m) return false; return Array.from(m.querySelectorAll('div')).some(function(x){ return (x.textContent||'').trim() === '编辑图片'; }); })()`);
check('T16-1', hasItem, `网格右键菜单有「编辑图片」(${card.title})`);
// 点它 → 查看器 + 调整态直达
await evaluate(`(function(){ var m = document.querySelector('[data-testid="context-menu"]'); var b = Array.from(m.querySelectorAll('div')).find(function(x){ return (x.textContent||'').trim() === '编辑图片'; }); if(b) b.click(); return 1; })()`);
await sleep(1500);
const viewerOpen = await evaluate(`!!document.querySelector('[title="编辑图片"]')`);
const panelOpen = await evaluate(`!!document.querySelector('#aurora-adjust-slot .adjust-inner-scroll, #aurora-adjust-slot [title="裁剪"]')`);
check('T16-2', viewerOpen && panelOpen, `直达调整态: 查看器开=${viewerOpen}, 调整面板开=${panelOpen}`);

// 2) 按钮 tooltip = 编辑图片
const tip = await evaluate(`document.querySelector('[title="编辑图片"]') ? document.querySelector('[title="编辑图片"]').getAttribute('title') : 'MISSING'`);
check('T16-3', tip === '编辑图片', `顶部按钮说明: "${tip}"`);

// 3) 查看器右键 → 编辑图片(先关调整态,再从右键重开)
await evaluate(`(function(){ var b = document.querySelector('[title="编辑图片"]'); if(b) b.click(); return 1; })()`);
await sleep(600);
const panelClosed = await evaluate(`!document.querySelector('#aurora-adjust-slot [title="裁剪"]')`);
const cv = await evaluate(`(function(){ var c = document.querySelector('canvas[data-adjust-canvas]'); if(c) return JSON.stringify(c.getBoundingClientRect()); var i = document.querySelector('img[alt]'); return JSON.stringify(i.getBoundingClientRect()); })()`);
const pos = JSON.parse(cv);
await mouse('mousePressed', pos.left + pos.width * 0.5, pos.top + pos.height * 0.5, { button: 'right' });
await mouse('mouseReleased', pos.left + pos.width * 0.5, pos.top + pos.height * 0.5, { button: 'right' });
await sleep(700);
const hasItem2 = await evaluate(`!!document.querySelector('[data-testid="viewer-context-menu"]')`);
const itemText = await evaluate(`(function(){ var m = document.querySelector('[data-testid="viewer-context-menu"]'); return m ? (m.textContent||'').indexOf('编辑图片') >= 0 : false; })()`);
check('T16-4', panelClosed, '调整面板已关闭(重开前)');
check('T16-5', hasItem2 && itemText, '查看器右键菜单有「编辑图片」');
// 点它 → 面板重开
await evaluate(`(function(){ var m = document.querySelector('[data-testid="viewer-context-menu"]'); var b = Array.from(m.querySelectorAll('div')).find(function(x){ return (x.textContent||'').trim() === '编辑图片'; }); if(b) b.click(); return 1; })()`);
await sleep(800);
const panelReopen = await evaluate(`!!document.querySelector('#aurora-adjust-slot [title="裁剪"]')`);
check('T16-6', panelReopen, `右键编辑图片重开调整面板=${panelReopen}`);

// 清理:关调整态(丢弃会话)
await evaluate(`(function(){ var b = document.querySelector('[title="编辑图片"]'); if(b) b.click(); return 1; })()`);
console.log(fail === 0 ? '[T16] 全部通过' : `[T16] ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
