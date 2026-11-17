// 分组收起冒烟：复现"收起上方'文件夹'组导致下方 PNG 组虚拟窗口错位整组空白"。
// 步骤：回顶 → 展开"文件夹" → 滚到 PNG → 收起"文件夹" → 断言 PNG 卡片仍在视口内渲染。
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(p => p.type === 'page' && /localhost:14422/.test(p.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`test/${name}`, Buffer.from(r.data, 'base64'));
};

const FIND = "(() => { const hs=[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes('sticky top-0')); const pick=(p)=>hs.find(d=>(d.textContent||'').trim().startsWith(p)); const folder=pick('文件夹'); if(!folder) return JSON.stringify({error:'no folder header'}); const png=pick('PNG'); const sc=(()=>{let p=folder.parentElement; while(p){const s=getComputedStyle(p); if(/(auto|scroll)/.test(s.overflowY)) return p; p=p.parentElement;} return document.scrollingElement;})(); const grp=(h)=>h.parentElement; const content=(h)=>{const c=grp(h).children; return c.length>1?c[1]:null;}; const info=(h)=>{const c=content(h); return c?{cards:c.querySelectorAll('.file-item').length,h:c.getBoundingClientRect().height,offsetTop:c.offsetTop,rectTop:c.getBoundingClientRect().top}:null;}; return JSON.stringify({scrollTop:sc.scrollTop, scTop:sc.getBoundingClientRect().top, scH:sc.getBoundingClientRect().height, folderCollapsed:!content(folder), folder:info(folder), png:info(png)}); })()";

console.log('--- state after scroll-to-top + expand:');
await evaluate(`(() => { const hs=[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes('sticky top-0')); const folder=hs.find(d=>(d.textContent||'').trim().startsWith('文件夹')); let p=folder.parentElement; while(p){const s=getComputedStyle(p); if(/(auto|scroll)/.test(s.overflowY)) break; p=p.parentElement;} p.scrollTop=0; return 'ok'; })()`);
await sleep(400);
// 若"文件夹"当前是收起态则展开（点组头）
await evaluate(`(() => { const hs=[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes('sticky top-0')); const folder=hs.find(d=>(d.textContent||'').trim().startsWith('文件夹')); const grp=folder.parentElement; if(grp.children.length===1) folder.click(); return 'clicked-expand-or-already-open'; })()`);
await sleep(500);
console.log(JSON.parse(await evaluate(FIND)));

console.log('--- scroll PNG into view, then collapse folder group:');
await evaluate(`(() => { const hs=[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes('sticky top-0')); const png=hs.find(d=>(d.textContent||'').trim().startsWith('PNG')); const sc=(()=>{let p=png.parentElement; while(p){const s=getComputedStyle(p); if(/(auto|scroll)/.test(s.overflowY)) return p; p=p.parentElement;} })(); const c=png.parentElement.children[1]; sc.scrollTop = png.parentElement.offsetTop - 60; return 'scrolled ' + sc.scrollTop; })()`);
await sleep(400);
await shot('gfix-1-before-collapse.png');
const before = JSON.parse(await evaluate(FIND));
console.log('before collapse:', before);
if (!before.png || before.png.cards === 0) throw new Error('PRECHECK FAILED: PNG empty even before collapse');

await evaluate(`(() => { const hs=[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes('sticky top-0')); const folder=hs.find(d=>(d.textContent||'').trim().startsWith('文件夹')); folder.click(); return 'collapsed'; })()`);
await sleep(600);
await shot('gfix-2-after-collapse.png');
const after = JSON.parse(await evaluate(FIND));
console.log('after collapse:', after);

// 断言：收起后 PNG 卡片仍渲染，且至少一张落在滚动容器可视区内
const scRectTop = after.scTop, scRectBottom = after.scTop + after.scH;
const visibleCards = await evaluate(`(() => { const hs=[...document.querySelectorAll('div')].filter(d=>d.className&&String(d.className).includes('sticky top-0')); const png=hs.find(d=>(d.textContent||'').trim().startsWith('PNG')); const c=png.parentElement.children[1]; const sc=(()=>{let p=png.parentElement; while(p){const s=getComputedStyle(p); if(/(auto|scroll)/.test(s.overflowY)) return p; p=p.parentElement;}})(); const sr=sc.getBoundingClientRect(); let vis=0; c.querySelectorAll('.file-item').forEach(card=>{const r=card.getBoundingClientRect(); if(r.bottom>sr.top&&r.top<sr.bottom&&r.height>0) vis++;}); return vis; })()`);
console.log('visible PNG cards in viewport after collapse:', visibleCards);

let ok = true;
if (!after.png || after.png.cards === 0) { console.log('FAIL: PNG group has 0 cards after collapsing folder group'); ok = false; }
if (visibleCards === 0) { console.log('FAIL: no PNG card inside viewport after collapse'); ok = false; }
// offsetTop 必须实时反映收起后的位置（旧 bug：陈旧偏移导致窗口错位）
if (after.png && before.png && Math.abs(after.png.offsetTop - after.png.rectTop - (after.scrollTop - after.scrollTop)) > 1) { /* 结构性检查太绕，改为下方直接比较 */ }
if (after.png && Math.abs(after.png.offsetTop - (after.png.rectTop + after.scrollTop - after.scTop)) > 2) {
  console.log(`WARN: offsetTop(${after.png.offsetTop}) vs rectTop+scroll(${(after.png.rectTop + after.scrollTop - after.scTop).toFixed(1)}) mismatch → 测量可能陈旧`);
  ok = false;
}
console.log(ok ? 'PASS ✅ 收起"文件夹"后 PNG 组内容正常渲染' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
