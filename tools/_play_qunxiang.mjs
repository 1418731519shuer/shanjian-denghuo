import { spawn, execFileSync } from 'node:child_process';
import * as path from 'node:path'; import * as os from 'node:os'; import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME = path.join(ROOT, 'games_output', '仙侠问道·群像传');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('python', ['-m', 'http.server', '8149', '--bind', '127.0.0.1'], { cwd: GAME, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-'));
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new', '--remote-debugging-port=9249', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { for (const p of [server, edge]) try { execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
process.on('exit', cleanup);
const waitFor = async (fn, ms, what) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('超时: ' + what); await sleep(250); } };
await waitFor(async () => (await fetch('http://127.0.0.1:8149/index.html')).ok, 10000, 'server');
await waitFor(async () => (await fetch('http://127.0.0.1:9249/json/version')).ok, 15000, 'edge');
const page = (await (await fetch('http://127.0.0.1:9249/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(((m.params.exceptionDetails.exception||{}).description||'').split('\n')[0]); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  return r.result.result ? r.result.result.value : undefined; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8149/' });
await waitFor(() => ev(`document.readyState === 'complete'`), 20000, '加载');
await sleep(1200);
console.log('标题:', await ev(`document.getElementById('game-title').textContent`));
await ev(`document.getElementById('btn-start').click()`); await sleep(300);
if (await ev(`!document.getElementById('name-input-overlay').classList.contains('hidden')`)) {
  await ev(`document.getElementById('name-input-field').value='女主'`); await ev(`document.getElementById('name-input-confirm').click()`);
}
await sleep(1200);
const seen = new Set(); let ended = '';
for (let i = 0; i < 400; i++) {
  seen.add(await ev(`script.scenes[sceneIdx].id`));
  const st = await ev(`(() => {
    if (!document.getElementById('end-screen').classList.contains('hidden'))
      return { t: 'end', label: (document.getElementById('end-label')||{}).textContent || '' };
    if (document.getElementById('inspect-skip')) return { t: 'insp' };
    if (!document.getElementById('viewlayer').classList.contains('hidden')) return { t: 'view' };
    if (!document.getElementById('cglayer').classList.contains('hidden')) return { t: 'cg' };
    if (!document.getElementById('check-layer').classList.contains('hidden')) return { t: 'check' };
    if (document.querySelector('#choices .choice-btn')) return { t: 'choice' };
    return { t: 'dlg' };
  })()`);
  if (st.t === 'end') { ended = st.label; break; }
  if (st.t === 'insp') await ev(`document.getElementById('inspect-skip').click()`);
  else if (st.t === 'view') await ev(`document.getElementById('viewlayer').click()`);
  else if (st.t === 'cg') await ev(`document.getElementById('cglayer').click()`);
  else if (st.t === 'check') await ev(`finishCheck()`);
  else if (st.t === 'choice') {
    /* 优先选带路线 flag 的选项（进路线） */
    await ev(`(() => {
      const bs = [...document.querySelectorAll('#choices .choice-btn:not(.disabled)')];
      bs[0].click();
    })()`);
  } else await ev(`document.getElementById('dlg').click()`);
  await sleep(80);
}
console.log('路径:', [...seen].join(' → '));
console.log('结局:', ended || '(未到达)');
console.log('页面错误:', errors.length, errors.slice(0,2).join('/'));
console.log(ended ? '通关 PASS' : 'FAIL');
cleanup(); process.exit(0);
